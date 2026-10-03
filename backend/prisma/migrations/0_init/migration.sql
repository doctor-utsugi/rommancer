-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(64) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER',
    `locale` VARCHAR(8) NOT NULL DEFAULT 'es',
    `ssUser` TEXT NULL,
    `ssPassword` TEXT NULL,
    `raUser` TEXT NULL,
    `raApiKey` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `User_username_key`(`username`),
    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefreshToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Invitation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `token` VARCHAR(64) NOT NULL,
    `role` ENUM('ADMIN', 'USER') NOT NULL DEFAULT 'USER',
    `createdBy` INTEGER NOT NULL,
    `usedById` INTEGER NULL,
    `usedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Invitation_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Setting` (
    `key` VARCHAR(64) NOT NULL,
    `value` TEXT NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `System` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `manufacturer` VARCHAR(64) NOT NULL,
    `datName` VARCHAR(191) NOT NULL,
    `datAliases` JSON NULL,
    `extensions` JSON NOT NULL,
    `headerType` VARCHAR(16) NOT NULL DEFAULT 'none',
    `mediaType` VARCHAR(16) NOT NULL DEFAULT 'rom',
    `raConsoleId` INTEGER NULL,
    `ssSystemId` INTEGER NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `System_slug_key`(`slug`),
    UNIQUE INDEX `System_datName_key`(`datName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DatSource` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('NOINTRO', 'REDUMP', 'FBNEO', 'MAME', 'HACKS', 'OTHER') NOT NULL,
    `systemId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `version` VARCHAR(64) NULL,
    `fileSha1` VARCHAR(40) NOT NULL,
    `fileName` VARCHAR(255) NULL,
    `importedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `romCount` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `DatSource_systemId_type_name_key`(`systemId`, `type`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Game` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `systemId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `titleNormalized` VARCHAR(255) NOT NULL,
    `releaseYear` INTEGER NULL,
    `developer` VARCHAR(128) NULL,
    `publisher` VARCHAR(128) NULL,
    `genre` VARCHAR(128) NULL,
    `players` VARCHAR(32) NULL,
    `description` TEXT NULL,
    `ssGameId` INTEGER NULL,
    `scrapedAt` DATETIME(3) NULL,

    INDEX `Game_title_idx`(`title`),
    UNIQUE INDEX `Game_systemId_titleNormalized_key`(`systemId`, `titleNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Rom` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gameId` INTEGER NOT NULL,
    `datSourceId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `regions` JSON NOT NULL,
    `languages` JSON NOT NULL,
    `revision` VARCHAR(32) NULL,
    `flags` JSON NOT NULL,
    `isBios` BOOLEAN NOT NULL DEFAULT false,
    `raHash` CHAR(32) NULL,
    `raGameId` INTEGER NULL,

    INDEX `Rom_raHash_idx`(`raHash`),
    INDEX `Rom_gameId_idx`(`gameId`),
    UNIQUE INDEX `Rom_datSourceId_name_key`(`datSourceId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RomPart` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `romId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `size` BIGINT NOT NULL,
    `crc32` CHAR(8) NULL,
    `md5` CHAR(32) NULL,
    `sha1` CHAR(40) NULL,
    `headerlessSize` BIGINT NULL,
    `headerlessCrc` CHAR(8) NULL,
    `headerlessMd5` CHAR(32) NULL,
    `headerlessSha1` CHAR(40) NULL,

    INDEX `RomPart_sha1_idx`(`sha1`),
    INDEX `RomPart_md5_idx`(`md5`),
    INDEX `RomPart_crc32_size_idx`(`crc32`, `size`),
    INDEX `RomPart_headerlessSha1_idx`(`headerlessSha1`),
    INDEX `RomPart_headerlessMd5_idx`(`headerlessMd5`),
    INDEX `RomPart_romId_idx`(`romId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RomHack` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gameId` INTEGER NOT NULL,
    `baseRomId` INTEGER NULL,
    `datSourceId` INTEGER NULL,
    `type` ENUM('HACK', 'TRANSLATION', 'IMPROVEMENT', 'OTHER') NOT NULL DEFAULT 'HACK',
    `title` VARCHAR(255) NOT NULL,
    `author` VARCHAR(255) NULL,
    `version` VARCHAR(64) NULL,
    `language` VARCHAR(32) NULL,
    `description` TEXT NULL,
    `sourceUrl` VARCHAR(512) NULL,
    `size` BIGINT NULL,
    `crc32` CHAR(8) NULL,
    `md5` CHAR(32) NULL,
    `sha1` CHAR(40) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RomHack_sha1_idx`(`sha1`),
    INDEX `RomHack_md5_idx`(`md5`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RomPath` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `label` VARCHAR(128) NOT NULL,
    `path` VARCHAR(700) NOT NULL,
    `systemId` INTEGER NULL,
    `isUploadTarget` BOOLEAN NOT NULL DEFAULT false,
    `readOnly` BOOLEAN NOT NULL DEFAULT false,
    `lastScanAt` DATETIME(3) NULL,

    UNIQUE INDEX `RomPath_path_key`(`path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RomFile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `romPathId` INTEGER NOT NULL,
    `pathKey` CHAR(40) NOT NULL,
    `relativePath` VARCHAR(1024) NOT NULL,
    `archiveEntry` VARCHAR(512) NULL,
    `size` BIGINT NOT NULL,
    `fileSize` BIGINT NOT NULL DEFAULT 0,
    `quickHash` CHAR(40) NULL,
    `mtimeMs` BIGINT NOT NULL,
    `crc32` CHAR(8) NOT NULL,
    `md5` CHAR(32) NULL,
    `sha1` CHAR(40) NULL,
    `headerlessCrc` CHAR(8) NULL,
    `headerlessMd5` CHAR(32) NULL,
    `headerlessSha1` CHAR(40) NULL,
    `raHash` CHAR(32) NULL,
    `systemId` INTEGER NULL,
    `status` ENUM('MATCHED', 'HACK', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    `romPartId` INTEGER NULL,
    `romHackId` INTEGER NULL,
    `scannedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RomFile_sha1_idx`(`sha1`),
    INDEX `RomFile_quickHash_idx`(`quickHash`),
    INDEX `RomFile_romPartId_idx`(`romPartId`),
    INDEX `RomFile_status_idx`(`status`),
    UNIQUE INDEX `RomFile_romPathId_pathKey_key`(`romPathId`, `pathKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Media` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gameId` INTEGER NULL,
    `romId` INTEGER NULL,
    `type` ENUM('COVER', 'SCREENSHOT', 'TITLE', 'MANUAL', 'VIDEO', 'MARQUEE', 'WHEEL') NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `region` VARCHAR(16) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Media_gameId_type_idx`(`gameId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `List` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ownerId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `visibility` ENUM('PRIVATE', 'SHARED', 'PUBLIC') NOT NULL DEFAULT 'PRIVATE',
    `isCollaborative` BOOLEAN NOT NULL DEFAULT false,
    `parentListId` INTEGER NULL,
    `derivedFilter` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ListItem` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `listId` INTEGER NOT NULL,
    `gameId` INTEGER NULL,
    `romId` INTEGER NULL,
    `hackId` INTEGER NULL,
    `itemKey` VARCHAR(24) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `note` VARCHAR(512) NULL,

    UNIQUE INDEX `ListItem_listId_itemKey_key`(`listId`, `itemKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ListShare` (
    `listId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `canEdit` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`listId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Console` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(128) NOT NULL,
    `manufacturer` VARCHAR(64) NOT NULL,
    `formFactor` VARCHAR(32) NOT NULL DEFAULT 'handheld',

    UNIQUE INDEX `Console_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Firmware` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `romsRoot` VARCHAR(255) NOT NULL,
    `savesRoot` VARCHAR(255) NOT NULL,
    `statesRoot` VARCHAR(255) NOT NULL,
    `biosRoot` VARCHAR(255) NOT NULL,
    `systemMap` JSON NOT NULL,
    `savesLayout` VARCHAR(16) NOT NULL DEFAULT 'flat',

    UNIQUE INDEX `Firmware_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Device` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `consoleId` INTEGER NOT NULL,
    `firmwareId` INTEGER NOT NULL,
    `connType` ENUM('LOCAL', 'SSH') NOT NULL,
    `rootPath` VARCHAR(512) NOT NULL,
    `sshHost` VARCHAR(255) NULL,
    `sshPort` INTEGER NULL DEFAULT 22,
    `sshUser` VARCHAR(64) NULL,
    `sshPassword` TEXT NULL,
    `sshKey` TEXT NULL,
    `overrides` JSON NULL,
    `syncSaves` BOOLEAN NOT NULL DEFAULT false,
    `lastSyncAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Emulator` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(64) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `core` VARCHAR(64) NULL,
    `saveFormat` VARCHAR(16) NOT NULL DEFAULT 'raw',
    `saveExt` VARCHAR(16) NOT NULL,
    `stateExt` VARCHAR(16) NULL,

    UNIQUE INDEX `Emulator_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Save` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `gameId` INTEGER NULL,
    `romId` INTEGER NULL,
    `emulatorId` INTEGER NOT NULL,
    `kind` ENUM('SAVE', 'STATE') NOT NULL,
    `slot` INTEGER NOT NULL DEFAULT 0,
    `baseName` VARCHAR(255) NOT NULL,
    `currentVersionId` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Save_userId_emulatorId_kind_slot_baseName_key`(`userId`, `emulatorId`, `kind`, `slot`, `baseName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SaveVersion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saveId` INTEGER NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `size` INTEGER NOT NULL,
    `sha1` CHAR(40) NOT NULL,
    `fileMtime` DATETIME(3) NOT NULL,
    `sourceDeviceId` INTEGER NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SaveVersion_saveId_idx`(`saveId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RaGame` (
    `id` INTEGER NOT NULL,
    `systemId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `numAchievements` INTEGER NOT NULL DEFAULT 0,
    `imageIcon` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RaHash` (
    `hash` CHAR(32) NOT NULL,
    `raGameId` INTEGER NOT NULL,

    INDEX `RaHash_raGameId_idx`(`raGameId`),
    PRIMARY KEY (`hash`, `raGameId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Job` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `type` VARCHAR(32) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `params` JSON NOT NULL,
    `total` INTEGER NOT NULL DEFAULT 0,
    `processed` INTEGER NOT NULL DEFAULT 0,
    `message` VARCHAR(512) NULL,
    `log` MEDIUMTEXT NULL,
    `result` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,

    INDEX `Job_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Invitation` ADD CONSTRAINT `Invitation_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DatSource` ADD CONSTRAINT `DatSource_systemId_fkey` FOREIGN KEY (`systemId`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Game` ADD CONSTRAINT `Game_systemId_fkey` FOREIGN KEY (`systemId`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Rom` ADD CONSTRAINT `Rom_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Rom` ADD CONSTRAINT `Rom_datSourceId_fkey` FOREIGN KEY (`datSourceId`) REFERENCES `DatSource`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomPart` ADD CONSTRAINT `RomPart_romId_fkey` FOREIGN KEY (`romId`) REFERENCES `Rom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomHack` ADD CONSTRAINT `RomHack_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomHack` ADD CONSTRAINT `RomHack_baseRomId_fkey` FOREIGN KEY (`baseRomId`) REFERENCES `Rom`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomHack` ADD CONSTRAINT `RomHack_datSourceId_fkey` FOREIGN KEY (`datSourceId`) REFERENCES `DatSource`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomFile` ADD CONSTRAINT `RomFile_romPathId_fkey` FOREIGN KEY (`romPathId`) REFERENCES `RomPath`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomFile` ADD CONSTRAINT `RomFile_romPartId_fkey` FOREIGN KEY (`romPartId`) REFERENCES `RomPart`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RomFile` ADD CONSTRAINT `RomFile_romHackId_fkey` FOREIGN KEY (`romHackId`) REFERENCES `RomHack`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Media` ADD CONSTRAINT `Media_romId_fkey` FOREIGN KEY (`romId`) REFERENCES `Rom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `List` ADD CONSTRAINT `List_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `List` ADD CONSTRAINT `List_parentListId_fkey` FOREIGN KEY (`parentListId`) REFERENCES `List`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListItem` ADD CONSTRAINT `ListItem_listId_fkey` FOREIGN KEY (`listId`) REFERENCES `List`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListItem` ADD CONSTRAINT `ListItem_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListItem` ADD CONSTRAINT `ListItem_romId_fkey` FOREIGN KEY (`romId`) REFERENCES `Rom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListItem` ADD CONSTRAINT `ListItem_hackId_fkey` FOREIGN KEY (`hackId`) REFERENCES `RomHack`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListShare` ADD CONSTRAINT `ListShare_listId_fkey` FOREIGN KEY (`listId`) REFERENCES `List`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListShare` ADD CONSTRAINT `ListShare_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device` ADD CONSTRAINT `Device_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device` ADD CONSTRAINT `Device_consoleId_fkey` FOREIGN KEY (`consoleId`) REFERENCES `Console`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Device` ADD CONSTRAINT `Device_firmwareId_fkey` FOREIGN KEY (`firmwareId`) REFERENCES `Firmware`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Save` ADD CONSTRAINT `Save_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Save` ADD CONSTRAINT `Save_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Save` ADD CONSTRAINT `Save_romId_fkey` FOREIGN KEY (`romId`) REFERENCES `Rom`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Save` ADD CONSTRAINT `Save_emulatorId_fkey` FOREIGN KEY (`emulatorId`) REFERENCES `Emulator`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SaveVersion` ADD CONSTRAINT `SaveVersion_saveId_fkey` FOREIGN KEY (`saveId`) REFERENCES `Save`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SaveVersion` ADD CONSTRAINT `SaveVersion_sourceDeviceId_fkey` FOREIGN KEY (`sourceDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RaGame` ADD CONSTRAINT `RaGame_systemId_fkey` FOREIGN KEY (`systemId`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RaHash` ADD CONSTRAINT `RaHash_raGameId_fkey` FOREIGN KEY (`raGameId`) REFERENCES `RaGame`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Job` ADD CONSTRAINT `Job_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

