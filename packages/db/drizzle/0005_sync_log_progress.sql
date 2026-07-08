ALTER TABLE `sync_logs` ADD `progress_phase` text;
--> statement-breakpoint
ALTER TABLE `sync_logs` ADD `progress_done` integer;
--> statement-breakpoint
ALTER TABLE `sync_logs` ADD `progress_total` integer;
--> statement-breakpoint
ALTER TABLE `sync_logs` ADD `current_git_path` text;
