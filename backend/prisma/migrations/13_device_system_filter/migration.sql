-- The per-device system exclusions become a filter: { newAuto, excluded, known }
ALTER TABLE `Device` RENAME COLUMN `excludedSystems` TO `systemFilter`;
UPDATE `Device` SET `systemFilter` = JSON_OBJECT('newAuto', true, 'excluded', `systemFilter`, 'known', JSON_ARRAY()) WHERE JSON_TYPE(`systemFilter`) = 'ARRAY';
