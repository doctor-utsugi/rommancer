-- DropForeignKey
ALTER TABLE `Game` DROP FOREIGN KEY `Game_systemId_fkey`;

-- DropIndex
DROP INDEX `Game_systemId_titleNormalized_key` ON `Game`;

-- AlterTable
ALTER TABLE `DatSource` MODIFY `type` ENUM('USER', 'NOINTRO', 'REDUMP', 'FBNEO', 'MAME', 'HACKS', 'OTHER') NOT NULL;

-- AlterTable
ALTER TABLE `Device` ADD COLUMN `lastSeenAt` DATETIME(3) NULL,
    ADD COLUMN `tokenCreatedAt` DATETIME(3) NULL,
    ADD COLUMN `tokenHash` CHAR(64) NULL,
    MODIFY `connType` ENUM('LOCAL', 'SSH', 'AGENT') NOT NULL;

-- AlterTable
ALTER TABLE `Game` ADD COLUMN `createdById` INTEGER NULL,
    ADD COLUMN `groupConfidence` VARCHAR(8) NOT NULL DEFAULT 'high',
    ADD COLUMN `metaSources` JSON NULL,
    ADD COLUMN `tgdbGameId` INTEGER NULL,
    ADD COLUMN `wikidataId` VARCHAR(16) NULL,
    ADD COLUMN `workId` INTEGER NULL;

-- AlterTable
ALTER TABLE `Invitation` ADD COLUMN `permissions` JSON NULL;

-- AlterTable
ALTER TABLE `Job` ADD COLUMN `runAfter` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `ListItem` ADD COLUMN `workId` INTEGER NULL;

-- AlterTable
ALTER TABLE `Media` ADD COLUMN `language` VARCHAR(16) NULL,
    ADD COLUMN `size` INTEGER NULL,
    MODIFY `type` ENUM('COVER', 'BOX_BACK', 'BOX_SIDE', 'BOX_3D', 'SUPPORT', 'SCREENSHOT', 'TITLE', 'FLYER', 'FANART', 'MANUAL', 'VIDEO', 'MARQUEE', 'WHEEL') NOT NULL;

-- AlterTable
ALTER TABLE `RaGame` ADD COLUMN `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `Rom` ADD COLUMN `checkedAt` DATETIME(3) NULL,
    ADD COLUMN `createdById` INTEGER NULL,
    ADD COLUMN `localTitle` VARCHAR(255) NULL,
    ADD COLUMN `parentName` VARCHAR(255) NULL,
    ADD COLUMN `removedFromSource` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `serial` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `RomFile` ADD COLUMN `container` VARCHAR(8) NULL,
    ADD COLUMN `discId` VARCHAR(16) NULL,
    ADD COLUMN `uploadedById` INTEGER NULL,
    MODIFY `status` ENUM('MATCHED', 'HACK', 'UNVERIFIED', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE `RomHack` ADD COLUMN `hackName` VARCHAR(255) NULL,
    ADD COLUMN `removedFromSource` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `RomPath` ADD COLUMN `isDefaultTarget` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `targetScheme` VARCHAR(32) NOT NULL DEFAULT 'system',
    ADD COLUMN `targetSystems` JSON NULL;

-- El antiguo destino de subidas pasa a ser el destino predeterminado
UPDATE `RomPath` SET `isDefaultTarget` = `isUploadTarget`;
ALTER TABLE `RomPath` DROP COLUMN `isUploadTarget`;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `permissions` JSON NULL,
    ADD COLUMN `tgdbApiKey` TEXT NULL;

-- CreateTable
CREATE TABLE `Work` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(255) NOT NULL,
    `wikidataId` VARCHAR(16) NULL,
    `franchiseId` INTEGER NULL,
    `releaseYear` INTEGER NULL,

    UNIQUE INDEX `Work_wikidataId_key`(`wikidataId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Franchise` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `wikidataId` VARCHAR(16) NULL,

    UNIQUE INDEX `Franchise_wikidataId_key`(`wikidataId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GroupingEvidence` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(12) NOT NULL,
    `romId` INTEGER NULL,
    `gameId` INTEGER NULL,
    `systemId` INTEGER NOT NULL,
    `key` VARCHAR(255) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `confidence` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GroupingEvidence_kind_systemId_key_idx`(`kind`, `systemId`, `key`),
    INDEX `GroupingEvidence_romId_idx`(`romId`),
    INDEX `GroupingEvidence_gameId_idx`(`gameId`),
    UNIQUE INDEX `GroupingEvidence_kind_romId_gameId_source_key_key`(`kind`, `romId`, `gameId`, `source`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GroupingRule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(12) NOT NULL,
    `rule` VARCHAR(10) NOT NULL,
    `aRomId` INTEGER NULL,
    `bRomId` INTEGER NULL,
    `aGameId` INTEGER NULL,
    `bGameId` INTEGER NULL,
    `wikidataId` VARCHAR(16) NULL,
    `userId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReviewItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(16) NOT NULL,
    `systemId` INTEGER NULL,
    `gameId` INTEGER NULL,
    `key` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'open',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `resolvedBy` INTEGER NULL,

    INDEX `ReviewItem_status_kind_idx`(`status`, `kind`),
    UNIQUE INDEX `ReviewItem_kind_key_key`(`kind`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WikidataItem` (
    `qid` VARCHAR(16) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `names` JSON NOT NULL,
    `platforms` JSON NOT NULL,
    `year` INTEGER NULL,
    `seriesQid` VARCHAR(16) NULL,
    `franchiseQid` VARCHAR(16) NULL,
    `raIds` JSON NULL,
    `ssIds` JSON NULL,
    `modified` DATETIME(3) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`qid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WikidataLabel` (
    `qid` VARCHAR(16) NOT NULL,
    `label` VARCHAR(255) NOT NULL,

    PRIMARY KEY (`qid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RomPatch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `hackId` INTEGER NOT NULL,
    `format` VARCHAR(4) NOT NULL,
    `path` VARCHAR(255) NOT NULL,
    `size` INTEGER NOT NULL,
    `sha1` CHAR(40) NOT NULL,
    `baseRomId` INTEGER NULL,
    `baseCrc32` CHAR(8) NULL,
    `targetCrc32` CHAR(8) NULL,
    `sourceUrl` VARCHAR(512) NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RomPatch_sha1_key`(`sha1`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SourceState` (
    `key` VARCHAR(191) NOT NULL,
    `etag` VARCHAR(255) NULL,
    `lastModified` VARCHAR(64) NULL,
    `version` VARCHAR(64) NULL,
    `checkedAt` DATETIME(3) NULL,
    `changedAt` DATETIME(3) NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScrapeMiss` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gameId` INTEGER NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ScrapeMiss_gameId_source_key`(`gameId`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ScrapeQuota` (
    `key` VARCHAR(64) NOT NULL,
    `day` VARCHAR(10) NOT NULL,
    `requests` INTEGER NOT NULL DEFAULT 0,
    `ko` INTEGER NOT NULL DEFAULT 0,
    `maxPerDay` INTEGER NULL,
    `maxKoPerDay` INTEGER NULL,
    `maxPerMin` INTEGER NULL,
    `pausedUntil` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SaveDeviceState` (
    `saveId` INTEGER NOT NULL,
    `deviceId` INTEGER NOT NULL,
    `versionId` INTEGER NULL,
    `deviceSha1` CHAR(40) NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`saveId`, `deviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SaveConflict` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saveId` INTEGER NOT NULL,
    `deviceId` INTEGER NOT NULL,
    `deviceVersionId` INTEGER NOT NULL,
    `serverVersionId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `resolution` VARCHAR(8) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Device_tokenHash_key` ON `Device`(`tokenHash`);

-- CreateIndex
CREATE INDEX `Game_systemId_titleNormalized_idx` ON `Game`(`systemId`, `titleNormalized`);

-- CreateIndex
CREATE INDEX `Game_workId_idx` ON `Game`(`workId`);

-- AddForeignKey
ALTER TABLE `Game` ADD CONSTRAINT `Game_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `Work`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Game` ADD CONSTRAINT `Game_systemId_fkey` FOREIGN KEY (`systemId`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListItem` ADD CONSTRAINT `ListItem_workId_fkey` FOREIGN KEY (`workId`) REFERENCES `Work`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Work` ADD CONSTRAINT `Work_franchiseId_fkey` FOREIGN KEY (`franchiseId`) REFERENCES `Franchise`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomPatch` ADD CONSTRAINT `RomPatch_hackId_fkey` FOREIGN KEY (`hackId`) REFERENCES `RomHack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SaveDeviceState` ADD CONSTRAINT `SaveDeviceState_saveId_fkey` FOREIGN KEY (`saveId`) REFERENCES `Save`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SaveDeviceState` ADD CONSTRAINT `SaveDeviceState_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SaveConflict` ADD CONSTRAINT `SaveConflict_saveId_fkey` FOREIGN KEY (`saveId`) REFERENCES `Save`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SaveConflict` ADD CONSTRAINT `SaveConflict_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

