-- AlterTable
ALTER TABLE `Device` ADD COLUMN `picksListId` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Device_picksListId_key` ON `Device`(`picksListId`);

-- AddForeignKey
ALTER TABLE `Device` ADD CONSTRAINT `Device_picksListId_fkey` FOREIGN KEY (`picksListId`) REFERENCES `List`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

