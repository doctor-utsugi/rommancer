-- AlterTable
ALTER TABLE `JourneyRevision` ADD COLUMN `sourceDeviceId` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `JourneyRevision` ADD CONSTRAINT `JourneyRevision_sourceDeviceId_fkey` FOREIGN KEY (`sourceDeviceId`) REFERENCES `Device`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

