# CLI de referencia sobre rcheevos (MIT) para validar el hash RA de Rommancer en las pruebas
RC = ../rcheevos
CFLAGS = -O2 -I$(RC)/include -I$(RC)/src

rahash: main.c $(RC)/include/rc_hash.h
	$(CC) $(CFLAGS) -o $@ main.c $(RC)/src/rhash/*.c $(RC)/src/rcheevos/*.c $(RC)/src/rc_compat.c $(RC)/src/rc_util.c

$(RC)/include/rc_hash.h:
	git clone --depth 1 https://github.com/RetroAchievements/rcheevos.git $(RC)

clean:
	rm -f rahash
