-- AlterTable
ALTER TABLE `RomFile` ADD COLUMN `hackCheckedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `RomHack` ADD COLUMN `baseEvidence` VARCHAR(16) NULL,
    ADD COLUMN `headerlessSha1` CHAR(40) NULL;

-- CreateTable
CREATE TABLE `RomSignature` (
    `romId` INTEGER NOT NULL,
    `fileSha1` CHAR(40) NOT NULL,
    `chunks` INTEGER NOT NULL,
    `sample` MEDIUMBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`romId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `RomHack_headerlessSha1_idx` ON `RomHack`(`headerlessSha1`);

-- Origen del enlace de los romhacks existentes: los de DATs son exactos; el resto se enlazo por titulo
UPDATE `RomHack` SET `baseEvidence` = 'dat' WHERE `datSourceId` IS NOT NULL;
UPDATE `RomHack` SET `baseEvidence` = 'title' WHERE `datSourceId` IS NULL;
