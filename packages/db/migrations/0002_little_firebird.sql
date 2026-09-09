CREATE TYPE "public"."anchor_batch_status" AS ENUM('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');--> statement-breakpoint
CREATE TABLE "anchor_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" bigint NOT NULL,
	"merkle_root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"leaves" jsonb NOT NULL,
	"status" "anchor_batch_status" DEFAULT 'PENDING' NOT NULL,
	"chain_id" integer NOT NULL,
	"contract_address" text NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "anchor_batch_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_batches_batch_id_uq" ON "anchor_batches" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "anchor_batches_status_idx" ON "anchor_batches" USING btree ("status");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_anchor_batch_id_anchor_batches_id_fk" FOREIGN KEY ("anchor_batch_id") REFERENCES "public"."anchor_batches"("id") ON DELETE no action ON UPDATE no action;