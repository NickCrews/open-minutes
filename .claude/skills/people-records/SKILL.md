---
name: people-records
description: Conventions for a person's slug, name and bio in Open Minutes. Use when naming a person or writing their bio.
---

# People records

A person has a `slug`, a `name` and a `bio`, in the database's `people`
table. Set them in a changeset (the `transcript-cleanup` skill), asserting
first that the row is the person you mean:

```sql
SELECT om.assert((SELECT slug FROM people WHERE id = 57) IS NULL, 'person 57 has no slug yet');
UPDATE people SET slug = 'kyle-kelley', name = 'Kyle Kelley',
  bio = 'Girdwood Board of Supervisors member as of March 2026.'
WHERE id = 57;
```

## Rules

1. **The name is only the name.** "Mike Edgington", not "Mike Edgington
   (GBOS co-chair)". Titles, roles, employers and bodies go in the bio. Keep
   the person's own spelling and accents ("Mélisa Babb"), even where speech
   recognition hears it differently.
2. **The slug is the name in kebab-case**, ASCII only (`melisa-babb`). It
   is the person's stable ID across databases: row ids differ between
   prod, dev and test databases, so code, data and tests outside one
   database refer to people by slug. It doesn't change when the person's
   role does; if it must change (a misspelled name), change it everywhere
   it's used.
3. **Every known person has a bio.** If all you know is that they spoke at a
   meeting, say that much: "Girdwood Board of Supervisors staff who took the
   roll call in March 2026."
4. **Date every role.** Roles change, and a bio without dates goes stale
   silently. Write the date in words ("March 2026"), never "currently",
   "now", "recent" or "new". Attach a month and year to each role:
   - "as of March 2026": the person held the role at the latest meeting you
     have evidence from. Use this by default.
   - "from May 2026", "until April 2026", "2019-2022": when you know when the
     role started or ended.
   - "in March 2026": for a one-off appearance, such as presenting an item.
5. **Name the role plainly.** Spell out the body ("Girdwood Board of
   Supervisors member", "Planning and Zoning Commission chair") rather than
   an acronym; give an Assembly member's district ("Assembly member for
   Midtown (District 4)"). One or two sentences.
6. **Bios state facts from evidence:** the transcript (a roll call, a
   self-introduction, a commendation read into the record) or an official
   source such as the municipal board roster. Don't guess a title from what
   someone talks about. When a role changes, update the dates; don't delete
   the earlier role.
7. **Dashes are plain hyphens** ("2019-2022"), never en or em dashes.

## Examples

```json
{"slug":"mike-edgington","name":"Mike Edgington","bio":"Girdwood Board of Supervisors member for Seat D from February 2017 to April 2026; co-chair 2019-2022 and from 2024 to April 2026."}
{"slug":"anna-brawley","name":"Anna Brawley","bio":"Assembly member for West Anchorage (District 3) as of March 2026; vice chair until April 2026, then chair."}
{"slug":"daniel-king","name":"Daniel King","bio":"Municipal Development Services staff who presented the 2026 building code update (AO 2026-33) in March 2026."}
```
