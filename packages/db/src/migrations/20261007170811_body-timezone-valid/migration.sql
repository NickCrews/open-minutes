ALTER TABLE "bodies" ADD CONSTRAINT "bodies_timezone_valid" CHECK ((now() AT TIME ZONE "timezone") IS NOT NULL);--> statement-breakpoint
ALTER TABLE "bodies" ADD CONSTRAINT "bodies_timezone_iana" CHECK ("timezone" = 'UTC'
      OR "timezone" ~ '^[A-Za-z_]+(/[A-Za-z_-]+)+$'
      OR "timezone" ~ '^Etc/GMT[+-][0-9]{1,2}$');