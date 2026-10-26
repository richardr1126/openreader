-- Match the Speech SDK removal. Settings can contain a JSON string encoded
-- once or twice; remove either representation before deleting the provider.
DELETE FROM "admin_settings"
WHERE "key" = 'defaultTtsProvider'
  AND EXISTS (
    SELECT 1 FROM "admin_providers"
    WHERE "provider_type" = 'deepinfra'
      AND "admin_settings"."value_json" IN (to_jsonb("slug"), to_jsonb(to_jsonb("slug")::text))
  );
--> statement-breakpoint
DELETE FROM "admin_providers" WHERE "provider_type" = 'deepinfra';
