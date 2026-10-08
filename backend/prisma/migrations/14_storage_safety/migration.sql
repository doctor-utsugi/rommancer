-- Folder identity and health (a disk that is not mounted must never look like an emptied folder),
-- destination priority and free-space reserve, and folder-to-system overrides for odd folder names
ALTER TABLE `RomPath` ADD COLUMN `volumeId` CHAR(36) NULL,
    ADD COLUMN `wasMount` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `offlineAt` DATETIME(3) NULL,
    ADD COLUMN `offlineReason` VARCHAR(64) NULL,
    ADD COLUMN `scanWarning` VARCHAR(255) NULL,
    ADD COLUMN `reservePercent` INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN `priority` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `folderSystems` JSON NULL;

-- Files that disappeared, kept for a while so a move to another folder or disk reuses their hashes
CREATE TABLE `RomFileGone` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `quickHash` CHAR(40) NOT NULL,
    `fileSize` BIGINT NOT NULL,
    `data` JSON NOT NULL,
    `goneAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RomFileGone_quickHash_fileSize_idx`(`quickHash`, `fileSize`),
    INDEX `RomFileGone_goneAt_idx`(`goneAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
