Proyecto de gestor roms de videojuegos.

- Tiene una base de datos que se nutre de otras que existan como no-intro
- Aparte de la tabla de roms, tiene que tener una tabla de juegos, es decir, una cosa es Gran Turismo 2, el juego, como concepto, y otra las múltiples roms (la versión PAL, la NTSC, la japonesa, la 1.2, etc...). Las roms de la tabla de roms deben estar asociadas a las de juegos
- También debe asociar romhacks a los juegos
- Le tengo que poder decir en qué path están mis roms, y debe detectar automáticamente cuales tengo y cuáles me faltan respecto a la bd de todos los juegos
- Una de las features más importantes es que el programa permita confeccionar listas de juegos, ya sea de roms específicas o de juegos en general
- El programa tiene que tener checksums de roms, no comprobar por nombre, y ayudarme a ordenar por carpetas y renombrar bien las roms según estándares
- Debe ser multiusuario el programa. Distintos usuarios pueden crear sus propias listas y compartirlas etc
- Los usuarios no admin pueden ayudar a completar la colección subiendo roms, pero solo si esta coincide con hash de alguna rom de la base de datos o de retroachievements
- El programa debe permitir copiar las roms de una lista en un destino, por ejemplo una sd para consola de emulación
- Una feature importante es que pueda, con una lista de favoritos, poder crear una sublista que sea, por ejmplo con las alternativas de los roms Euro, USA, o compatibles con retroachievements
- El programa tiene que poder ayudarme a scrapear carátulas, screenshots y manuales de las roms, usando servicios externos, no hay que reinventar la rueda
- Los usuarios pueden registrar sus consolas o equipos en el programa, poniendo qué consola y firmware tiene, como por ejemplo AYN Thor con Android, o AYN Thor con Rockix (tablas de consola y de firmwares?) y los paths de SSH o tarjetas SD donde poner sus roms / savegames / savestates
- El programa tendrá que ser también un gestor de savegames y savestates que ayude a copiarlos entre consolas de emulación u ordenadores, una especie de Steam Cloud para roms, que debe ser capaz como mínimo de guardar savegames por emulador/core de retroarch diferente, pero idealmente convertirlas para que funcionen en los distintos emuladores y gestión de backups para no perder saves accidentalmente
- El programa lo quiero: con backend node, mysql, prisma y express, y frontend react con typescript y shadcn. Utiliza Podman no Docker
 
