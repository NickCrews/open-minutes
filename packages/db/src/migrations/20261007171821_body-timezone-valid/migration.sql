-- Whether `tz` is an IANA Area/Location zone Postgres recognizes, eg
-- 'America/Anchorage'. AT TIME ZONE alone also accepts abbreviations ('PST'),
-- POSIX offsets ('EST5EDT', 'Foo/Bar+3') and fixed zones ('UTC',
-- 'Etc/GMT+9'); only a named place follows its legislated changes to offset
-- and DST rules. Returns false rather than raising, so app code can call it to
-- check input (see packages/db/src/timezone.ts) and check constraints on any
-- table's timezone column can share it. NULL in, NULL out.
CREATE OR REPLACE FUNCTION is_iana_timezone(tz text) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN
  IF tz !~ '^[A-Za-z_]+(/[A-Za-z_-]+)+$' OR tz LIKE 'Etc/%' THEN
    RETURN false;
  END IF;
  PERFORM 'epoch'::timestamptz AT TIME ZONE tz;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  -- time zone "..." not recognized
  RETURN false;
END
$$;--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_timezone_valid" CHECK (is_iana_timezone("timezone"));