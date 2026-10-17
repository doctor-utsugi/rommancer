-- AlterTable
ALTER TABLE `Game` ADD COLUMN `baseGameId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `Game_baseGameId_idx` ON `Game`(`baseGameId`);

-- AddForeignKey
ALTER TABLE `Game` ADD CONSTRAINT `Game_baseGameId_fkey` FOREIGN KEY (`baseGameId`) REFERENCES `Game`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
