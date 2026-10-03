#!/bin/sh
# При старте контейнера записывает адрес OpenRemote в config.json.
# Так адрес можно поменять в .env и перезапустить контейнер без новой сборки.
set -eu

manager="${MANAGER_URL:-https://212.22.82.167}"
realm="${CABINET_REALM:-boiler}"
manager="${manager%/}"

case "$manager" in
  *\"*|*\\*)
    echo "MANAGER_URL содержит кавычки, так адрес записать нельзя: $manager" >&2
    exit 1
    ;;
esac
case "$realm" in
  *\"*|*\\*)
    echo "CABINET_REALM содержит кавычки, так имя записать нельзя: $realm" >&2
    exit 1
    ;;
esac

target=/usr/share/nginx/html/cabinet/config.json
mkdir -p "$(dirname "$target")"
cat > "$target" <<EOF
{
  "managerUrl": "${manager}",
  "realm": "${realm}"
}
EOF
echo "Кабинет ходит в OpenRemote: ${manager}, область ${realm}"
