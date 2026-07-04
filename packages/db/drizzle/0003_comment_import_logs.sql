CREATE TABLE `comment_import_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`document_count` integer,
	`comment_count` integer,
	`reply_count` integer,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`binding_id`) REFERENCES `bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
