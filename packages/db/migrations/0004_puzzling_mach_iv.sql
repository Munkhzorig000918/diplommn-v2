CREATE TABLE "status_lists" (
	"list_id" integer PRIMARY KEY NOT NULL,
	"credential" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"revoked_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "vc_hash" text;