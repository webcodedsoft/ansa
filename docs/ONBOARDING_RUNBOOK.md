# Onboarding an organisation by hand

Organizations one through ten are onboarded by hand (PRD §11, and §1.2 makes a self-serve builder
a v1 non-goal). This is the process, written down while doing it for the second time, with
the parts that were awkward left in rather than smoothed over — the awkward parts are the
requirements for any configuration UI that eventually replaces it.

`docs/ORGANIZATION_CONFIGURATION.md` says what the fields mean and which of them a organization is not
allowed to touch. That file is generated; this one is not.

---

## The seven steps

**1. Buy or assign a number at the carrier**, and point its voice webhook at
`POST {PUBLIC_BASE_URL}/telephony/voice`. Nothing in this repository does that, and there is
no check anywhere that it happened: a organization provisioned without it looks completely correct
in the database and never receives a call.

**2. Create the organization row.** Owner role, because `dialled_number` is the ingress routing
table and not the organization's to write.

```
MIGRATION_DIRECT_URL=... node tools/organization/provision.mjs "<organisation name>" <+E164>
```

It prints the organization id. Everything after this is keyed on it.

**3. Write the configuration file.** One JSON object, the whole configuration rather than a
patch. The shape and the bounds are in `docs/ORGANIZATION_CONFIGURATION.md`; the header comment of
`tools/organization/config.mjs` carries a worked example of each block. Keep it out of the
repository — `tools/organization/local/` is gitignored for this.

**4. Seal any credentials it refers to.** The config names a credential by reference; the
value never appears in it.

```
ORGANIZATION_ID=... node tools/organization/config.mjs credential <ref> bearer <token>
ORGANIZATION_ID=... node tools/organization/config.mjs credential <ref> signing <shared-secret>
```

This needs `TOOL_CREDENTIAL_KEY` set in `.env`, and the API process needs the same value.

**5. Publish.**

```
ORGANIZATION_ID=... node tools/organization/config.mjs publish tools/organization/local/<name>.json "<why>"
```

The note is mandatory. It is what makes the version history answer "why" rather than only
"what", and "why" is the question asked when a call goes wrong.

**6. Set what the operator sets.** Consent policy, calling hours and audio retention are on
the organization row and deliberately not reachable from the onboarding tool (§5 of the
configuration doc). Raw SQL as owner, today.

**7. Dial the number.** Nothing above proves anything. Listen for the greeting in their
words, in their voice, and ask for something their tools cover.

---

## What was awkward, doing it by hand

Recorded because a configuration UI has to solve these, and because most of them are also
worth fixing before it exists.

**Onboarding is two roles and three tools, and nothing says so.** `provision.mjs` runs as
the owner, `config.mjs` runs as `ansa_app` inside the organization's own scope, and step 6 is raw
SQL as the owner again. The split is correct — it is the difference between what the
platform grants and what the organisation chooses — but it is discovered rather than
described, and the first attempt at step 2 fails with a row-level-security error that names
nothing useful.

**Nothing validates that the number is wired at the carrier.** The most likely way to onboard
a organization wrongly is to do all seven steps and forget step 1, and the symptom is a phone that
rings nowhere. A health endpoint that lists registered numbers and asks the carrier which of
them point at us would catch it in a second.

**`voice_id` is unvalidated and fails loudly at the worst moment.** A wrong id publishes
happily, and the first call synthesises nothing, retries once, and hangs up. That is the
correct failure — an open silent line is worse — but it is discovered by a caller. A publish
that fetched the voice list and refused an unknown id would cost one HTTP request.

**A missing `TOOL_CREDENTIAL_KEY` fails at step 4 and again, silently, at step 5.** Sealing
refuses with a clear message. Publishing does not: a config full of tools publishes fine
without the key, and the tools are dropped at config load on every call with an error in the
log nobody is watching. The second organization's first published version was in exactly that state
for several minutes.

**The whole config, every time, is right and it is unforgiving.** Omitting `tools` publishes
a version with no tools rather than leaving the last one in place. That is the correct rule —
a patch history is unreadable — but it means the file in `tools/organization/local/` is the only
copy of the truth, and losing it means reconstructing the configuration from
`config.mjs show <version>`.

**`publish_organization_config` grows an argument per migration and old callers rot silently.**
Four migrations have widened it. An out-of-date call site fails with `function does not
exist`, which names neither the function's real signature nor the field that was added. The
development seed had been broken this way for three migrations. Named arguments, or a jsonb
parameter, would end this.

**An allowlist entry with a port in it matches nothing.** The egress allowlist matches
`URL.hostname`, which carries no port, so `api.example.com:8443` is an entry that can never
be hit. It was silent until Slice 7 made `parseConnectorConfig` compare the two; this repo's
own fixtures had it wrong in two places.

**Keyterms are the field most likely to be filled in wrongly by a well-meaning organization.** The
instinct is to list place names and staff names, and both are actively harmful — see
`apps/api/src/tenancy/defaults.ts` for what that cost on a live call. The bound is in the
generated doc and the tool does not enforce it, because "is this a personal name" is not a
thing code can decide.
