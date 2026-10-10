-- Shared saves, savestate screenshots and the core version each state was made with
-- AlterTable
ALTER TABLE `Device` ADD COLUMN `coreVersions` JSON NULL;

-- AlterTable
ALTER TABLE `SaveVersion` ADD COLUMN `coreVersion` VARCHAR(64) NULL,
    ADD COLUMN `shareNote` VARCHAR(255) NULL,
    ADD COLUMN `sharedAt` DATETIME(3) NULL,
    ADD COLUMN `thumbPath` VARCHAR(512) NULL;

-- CreateIndex
CREATE INDEX `SaveVersion_sharedAt_idx` ON `SaveVersion`(`sharedAt`);

