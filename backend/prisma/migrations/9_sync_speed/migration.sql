-- AlterTable
ALTER TABLE `Device` ADD COLUMN `inventoryHash` VARCHAR(40) NULL;

-- CreateIndex
CREATE INDEX `Rom_name_idx` ON `Rom`(`name`);
