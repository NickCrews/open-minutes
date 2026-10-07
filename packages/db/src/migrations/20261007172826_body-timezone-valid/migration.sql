-- Why `tz` isn't an IANA Area/Location zone Postgres recognizes, eg
-- 'America/Anchorage', as a message fit to show a user; NULL if it is one.
-- AT TIME ZONE alone also accepts abbreviations ('PST'), POSIX offsets
-- ('EST5EDT', 'Foo/Bar+3') and fixed zones ('UTC', 'Etc/GMT+9'); only a named
-- place follows its legislated changes to offset and DST rules. Check
-- constraints on any table's timezone column can share it, and app code can
-- call it to check input (see packages/db/src/timezone.ts). NULL in, NULL out.
CREATE OR REPLACE FUNCTION iana_timezone_error(tz text) RETURNS text
LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN
  IF tz LIKE 'Etc/%' THEN
    RETURN format('"%s" is a fixed UTC offset. Use the zone of a place, like "America/Anchorage", so daylight saving time and changes to local time law apply.', tz);
  END IF;
  IF tz !~ '^[A-Za-z_]+(/[A-Za-z_-]+)+$' THEN
    RETURN format('"%s" is not an IANA time zone name. Use the zone of a place, like "America/Anchorage".', tz);
  END IF;
  PERFORM 'epoch'::timestamptz AT TIME ZONE tz;
  RETURN NULL;
EXCEPTION WHEN invalid_parameter_value THEN
  -- time zone "..." not recognized
  RETURN format('"%s" is not a known time zone. Check the spelling, eg "America/Anchorage".', tz);
END
$$;--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_timezone_valid" CHECK (iana_timezone_error("timezone") IS NULL);