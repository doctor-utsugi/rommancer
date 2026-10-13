-- Files no database identified, so lists can hold them
CREATE TABLE `UnknownFile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fileKey` CHAR(40) NOT NULL,
    `sha1` CHAR(40) NULL,
    `headerlessSha1` CHAR(40) NULL,
    `name` VARCHAR(255) NOT NULL,
    `size` BIGINT NOT NULL DEFAULT 0,
    `systemId` INTEGER NULL,
    `baseGameId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `UnknownFile_fileKey_key`(`fileKey`),
    INDEX `UnknownFile_sha1_idx`(`sha1`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ListItem` ADD COLUMN `unknownId` INTEGER NULL;

ALTER TABLE `UnknownFile` ADD CONSTRAINT `UnknownFile_systemId_fkey` FOREIGN KEY (`systemId`) REFERENCES `System`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `UnknownFile` ADD CONSTRAINT `UnknownFile_baseGameId_fkey` FOREIGN KEY (`baseGameId`) REFERENCES `Game`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ListItem` ADD CONSTRAINT `ListItem_unknownId_fkey` FOREIGN KEY (`unknownId`) REFERENCES `UnknownFile`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Found by their content without a header too
CREATE INDEX `RomFile_headerlessSha1_idx` ON `RomFile`(`headerlessSha1`);
