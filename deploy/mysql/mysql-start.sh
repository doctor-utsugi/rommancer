#!/bin/sh
# The passwords of Rommancer's own MySQL live in /secrets, the API's DATA_DIR/secrets: made on the first start, read by
# MySQL when it creates its database and by the API to connect. An installation from before keeps the passwords its
# environment still gives (MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD): the database was created with them
set -e
keep() {
  [ -s "/secrets/$1" ] && return 0
  if [ -n "$2" ]; then printf '%s' "$2" > "/secrets/$1"
  else head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32 > "/secrets/$1"; fi
}
mkdir -p /secrets
keep mysql-root-password "${MYSQL_ROOT_PASSWORD:-}"
keep mysql-password "${MYSQL_PASSWORD:-}"
# MySQL reads them as its own user; the folder lets it reach only the files it is given
chmod 711 /secrets
chown mysql:mysql /secrets/mysql-root-password /secrets/mysql-password
chmod 600 /secrets/mysql-root-password /secrets/mysql-password
unset MYSQL_ROOT_PASSWORD MYSQL_PASSWORD
export MYSQL_ROOT_PASSWORD_FILE=/secrets/mysql-root-password MYSQL_PASSWORD_FILE=/secrets/mysql-password MYSQL_DATABASE=rommancer MYSQL_USER=rommancer
exec docker-entrypoint.sh "$@"
