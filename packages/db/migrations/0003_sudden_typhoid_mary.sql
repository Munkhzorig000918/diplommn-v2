ALTER TABLE "credentials" ADD COLUMN "vc" jsonb;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "vc_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "vc_key_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "status_list_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_status_list_index_uq" ON "credentials" USING btree ("status_list_index");--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "credentials_status_list_index_seq" START WITH 0 MINVALUE 0;
