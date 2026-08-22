-- Letting an organisation attach its own number, without letting it attach somebody else's.
--
-- Numbers have been operator-assigned since 0019, and the reason is written into that
-- migration: "No proof of control is available to prevent it: the carrier cannot vouch for a
-- number it does not sell." `organization_numbers` is the ownership table, `ansa_app` holds
-- SELECT on it and nothing else, and an organisation that could insert a row could claim a
-- line somebody else controls at their own carrier.
--
-- `numbers.controller.ts` already names the mechanism that would fix it: "a per-organisation
-- token the organisation puts in the voice webhook they configure at their own carrier, which
-- is the telephony equivalent of a DNS TXT record and which they can only do if they hold the
-- number". This builds that. The design was chosen before this migration existed; what was
-- missing was the column and the two functions.
--
-- **Why the webhook is the proof.** Configuring where a number sends its calls is something
-- only the holder of that number can do, at the carrier that sold it to them. So a call
-- arriving on a URL carrying an organisation's secret token proves two things at once: that
-- somebody holds the number, and which organisation they are. Nothing else needs checking, and
-- no operator has to be in the loop.
--
-- **The token is a bearer secret in a URL**, which is worth stating plainly rather than
-- discovering. It is the whole of the authentication for that path, so it is generated from 32
-- random bytes in the application rather than by a database default, it is never written to a
-- log line, and it is rotatable — an organisation that pasted it somewhere public rotates it
-- and reconfigures their carrier. Rotating detaches no number already proved.
--
-- **A held number is never transferred.** If the number already belongs to somebody the claim
-- is refused rather than moved, even though the caller has just proved they control it today.
-- Porting a number between organisations is an operator's job precisely because the losing
-- organisation cannot be asked at that moment, and a silent transfer is indistinguishable from
-- a hijack by whoever ported it away.

alter table organizations
  add column if not exists number_claim_token text;

comment on column organizations.number_claim_token is
  'Bearer secret this organisation puts in the voice webhook it configures at its own carrier, '
  'proving it holds the number that calls arrive on. Generated in the application from 32 '
  'random bytes, never logged, and rotatable without detaching numbers already proved.';

-- Partial, so the many organisations with no token do not collide on null.
create unique index if not exists organizations_number_claim_token_idx
  on organizations (number_claim_token)
  where number_claim_token is not null;

/*
 * Which organisation a claim token belongs to.
 *
 * SECURITY DEFINER because it runs at ingress, on a connection with no organisation scope set
 * — resolving the organisation is what it is *for*, exactly as `app.organization_for_number`
 * is. It takes a secret and returns an id, so it discloses nothing to a caller who does not
 * already hold the secret.
 *
 * A soft-deleted organisation resolves to nothing. An account that has been closed should not
 * still be collecting numbers.
 */
create or replace function app.organization_for_claim_token(p_token text)
returns uuid
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select o.id
    from organizations o
   where o.number_claim_token = p_token
     and o.number_claim_token is not null
     and o.deleted_at is null
   limit 1
$fn$;

revoke all on function app.organization_for_claim_token(text) from public;
grant execute on function app.organization_for_claim_token(text) to ansa_app;

/*
 * Attach a number to the organisation whose token proved control of it.
 *
 * Returns the organisation now holding the number, or null when nothing was proved. Null
 * covers an unknown token, a closed organisation, and a number somebody else already holds —
 * deliberately one answer, because the caller of this function is an unauthenticated webhook
 * and telling it which of those happened would turn it into an oracle for who holds what.
 *
 * Idempotent for the holder. Every call to a claimed number arrives on the same webhook, so
 * this runs on all of them and must not fail or duplicate on the second.
 *
 * SECURITY DEFINER for the same reason as the resolver above, and because `ansa_app` has no
 * INSERT on `organization_numbers` — that grant is the boundary 0019 established, and this
 * function is the single narrow hole through it. It can only ever insert a row for the
 * organisation that holds the token it was given.
 */
create or replace function app.claim_number_with_token(p_token text, p_number text)
returns uuid
language plpgsql
volatile security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  claimant uuid;
  holder   uuid;
begin
  if p_token is null or p_number is null or length(p_number) = 0 then
    return null;
  end if;

  claimant := app.organization_for_claim_token(p_token);
  if claimant is null then
    return null;
  end if;

  select n.organization_id into holder
    from organization_numbers n
   where n.number = p_number;

  if holder is not null then
    -- Theirs already: say so, so a repeat call is a no-op rather than an error. Somebody
    -- else's: refused, and not moved. See the header on why proving control today does not
    -- entitle you to take a number off whoever proved it yesterday.
    return case when holder = claimant then claimant else null end;
  end if;

  insert into organization_numbers (organization_id, number, note)
  values (claimant, p_number, 'proved by webhook token')
    -- Two calls to the same new number can race here. The loser sees the winner's row rather
    -- than a unique violation, and both are the same organisation, so the outcome is right
    -- either way.
    on conflict (number) do nothing;

  select n.organization_id into holder
    from organization_numbers n
   where n.number = p_number;

  return case when holder = claimant then claimant else null end;
end;
$fn$;

revoke all on function app.claim_number_with_token(text, text) from public;
grant execute on function app.claim_number_with_token(text, text) to ansa_app;
