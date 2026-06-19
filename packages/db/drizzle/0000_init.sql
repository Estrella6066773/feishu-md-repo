CREATE TABLE `bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`repo_path` text NOT NULL,
	`remote_url` text,
	`branch` text DEFAULT 'main' NOT NULL,
	`sync_mode` text NOT NULL,
	`feishu_target_json` text NOT NULL,
	`triggers_json` text NOT NULL,
	`options_json` text NOT NULL,
	`last_synced_sha` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `node_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`git_path` text NOT NULL,
	`feishu_target_type` text NOT NULL,
	`feishu_node_token` text NOT NULL,
	`feishu_node_type` text NOT NULL,
	`feishu_parent_token` text,
	`content_sha` text,
	FOREIGN KEY (`binding_id`) REFERENCES `bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`trigger` text NOT NULL,
	`from_sha` text,
	`to_sha` text,
	`status` text NOT NULL,
	`message` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`binding_id`) REFERENCES `bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
