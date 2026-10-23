-- Speech SDK is no longer a provider type. Forget the default when it named
-- one, so the first remaining enabled provider becomes the default, then
-- remove the providers. Users who chose one pick another provider. The app
-- writes settings as a JSON string inside jsonb, so the slug is matched both
-- encoded once and twice.
DELETE FROM "admin_settings"
WHERE "key" = 'defaultTtsProvider'
  AND EXISTS (
    SELECT 1 FROM "admin_providers"
    WHERE "provider_type" = 'speech-sdk'
      AND "admin_settings"."value_json" IN (to_jsonb("slug"), to_jsonb(to_jsonb("slug")::text))
  );
--> statement-breakpoint
DELETE FROM "admin_providers" WHERE "provider_type" = 'speech-sdk';
