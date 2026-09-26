-- Backfills columns that were added to drizzle/schema.ts (resumable narration
-- pipeline and audio export) without a matching migration.
--
-- Each ADD is guarded against information_schema so this migration is safe on a
-- database that already received these columns out of band (for example through
-- `drizzle-kit push`). MySQL 8 has no `ADD COLUMN IF NOT EXISTS`, hence the
-- prepared-statement form. The two MODIFY statements are idempotent as written.
ALTER TABLE `bookxExports` MODIFY COLUMN `status` enum('queued','assembling','ready','failed') NOT NULL DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE `bookxGenerationJobs` MODIFY COLUMN `status` enum('queued','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'queued';--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxChapters' AND COLUMN_NAME = 'audioStorageKey') = 0, 'ALTER TABLE `bookxChapters` ADD `audioStorageKey` varchar(512)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxChapters' AND COLUMN_NAME = 'audioDurationMs') = 0, 'ALTER TABLE `bookxChapters` ADD `audioDurationMs` int', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxExports' AND COLUMN_NAME = 'durationMs') = 0, 'ALTER TABLE `bookxExports` ADD `durationMs` int', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxExports' AND COLUMN_NAME = 'bytes') = 0, 'ALTER TABLE `bookxExports` ADD `bytes` bigint', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxExports' AND COLUMN_NAME = 'error') = 0, 'ALTER TABLE `bookxExports` ADD `error` varchar(512)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxExports' AND COLUMN_NAME = 'detail') = 0, 'ALTER TABLE `bookxExports` ADD `detail` json', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'skippedSegments') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `skippedSegments` int DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'provider') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `provider` varchar(80)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'model') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `model` varchar(160)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'voiceId') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `voiceId` varchar(160)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'cursorSegmentId') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `cursorSegmentId` varchar(32)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'cursorIndex') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `cursorIndex` int DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'rewindSegments') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `rewindSegments` int DEFAULT 1 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'leaseOwner') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `leaseOwner` varchar(64)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'leaseExpiresAt') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `leaseExpiresAt` timestamp NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'heartbeatAt') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `heartbeatAt` timestamp NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'pauseRequested') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `pauseRequested` int DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'cancelRequested') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `cancelRequested` int DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'renderedBytes') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `renderedBytes` bigint DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'renderedDurationMs') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `renderedDurationMs` int DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'startedAt') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `startedAt` timestamp NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxGenerationJobs' AND COLUMN_NAME = 'finishedAt') = 0, 'ALTER TABLE `bookxGenerationJobs` ADD `finishedAt` timestamp NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'textHash') = 0, 'ALTER TABLE `bookxSegments` ADD `textHash` varchar(64)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'voiceProvider') = 0, 'ALTER TABLE `bookxSegments` ADD `voiceProvider` varchar(80)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'voiceModel') = 0, 'ALTER TABLE `bookxSegments` ADD `voiceModel` varchar(160)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'voiceId') = 0, 'ALTER TABLE `bookxSegments` ADD `voiceId` varchar(160)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'audioMimeType') = 0, 'ALTER TABLE `bookxSegments` ADD `audioMimeType` varchar(80)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'audioBytes') = 0, 'ALTER TABLE `bookxSegments` ADD `audioBytes` int', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'audioDurationMs') = 0, 'ALTER TABLE `bookxSegments` ADD `audioDurationMs` int', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'renderAttempts') = 0, 'ALTER TABLE `bookxSegments` ADD `renderAttempts` int DEFAULT 0 NOT NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'lastError') = 0, 'ALTER TABLE `bookxSegments` ADD `lastError` varchar(512)', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;--> statement-breakpoint
SET @bookx_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookxSegments' AND COLUMN_NAME = 'renderedAt') = 0, 'ALTER TABLE `bookxSegments` ADD `renderedAt` timestamp NULL', 'DO 0');--> statement-breakpoint
PREPARE bookx_stmt FROM @bookx_ddl;--> statement-breakpoint
EXECUTE bookx_stmt;--> statement-breakpoint
DEALLOCATE PREPARE bookx_stmt;
