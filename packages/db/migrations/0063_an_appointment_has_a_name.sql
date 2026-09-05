-- An appointment has a name.
--
-- The diary was built for one job: a caller on the phone takes a slot the agent offered, and
-- what is worth recording about it is who they are and when it is. That is why an
-- `appointment_bookings` row has a `contact_id`, a `notes` and no title — the slot's meaning
-- was "the thing this calendar is for", said once in the calendar's own name.
--
-- A person keeping the diary at a desk works the other way round. They open the week, find an
-- empty Tuesday afternoon, and write *what it is*: "Second viewing — 14 Adeola Odeku", "Site
-- visit with the surveyor". Without a title such a row draws as a coloured block with a time
-- on it and nothing else, and a week of those is a week nobody can read. So a booking carries
-- a title, and the grid has something to print.
--
-- **Nullable, and it stays nullable.** Every booking taken by a call so far has no title and
-- is not wrong for it; the calendar's name and the contact are what that row means. A default
-- of '' would be a third state reading as "titled, with nothing", and a `not null` would make
-- this migration invent words for appointments nobody typed. Absent means the drawing falls
-- back to the contact's name, and to the calendar's name after that.
--
-- Nothing else changes. In particular the partial unique index on `(calendar_id, starts_at)`
-- stays exactly as it was: two live bookings may not start at the same minute, which is the
-- double-book somebody makes by accident. Two that merely overlap — a viewing at nine for an
-- hour and another at half past — are allowed, because a real diary allows them and the person
-- who wrote them both meant it. The slot arithmetic already refuses to *offer* a time that
-- overlaps a live booking, so a caller is never sold one; this is only about what a human may
-- write down on purpose.

alter table appointment_bookings
  add column if not exists title text;
