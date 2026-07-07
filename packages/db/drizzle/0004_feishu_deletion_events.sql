CREATE TABLE `feishu_deletion_events` (
	`id` text PRIMARY KEY NOT NULL,
	`file_token` text NOT NULL,
	`file_type` text NOT NULL,
	`event_type` text NOT NULL,
	`binding_id` text,
	`git_path` text,
	`mapping_id` text,
	`received_at` text NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`binding_id`) REFERENCES `bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_deletion_events_binding_pending` ON `feishu_deletion_events` (`binding_id`,`processed_at`);
--> statement-breakpoint
CREATE INDEX `idx_deletion_events_file_token` ON `feishu_deletion_events` (`file_token`);
