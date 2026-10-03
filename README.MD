# Личный кабинет котельной для OpenRemote

Мобильный кабинет в духе ежедневных экранов myHeat и ZONT: статусы, графики, уставки и режимы. Для человека это обычная ссылка. Приложение OpenRemote Console открывает тот же адрес и больше ничего не показывает.

OpenRemote здесь платформа: пользователи, права, активы, история и живые события. Кабинет сам котлом не управляет, он читает и пишет атрибуты Manager.

Рабочий OpenRemote уже запущен по адресу `https://212.22.82.167`. Корень открывает `/manager/`, Keycloak доступен на `/auth`. Страницы `/cabinet/` там пока нет. Порт 8080 на этом сервере занят другим веб-сервисом: кабинет его не использует и второй OpenRemote не поднимает.

Куда ходить за данными, записано в [ui/cabinet/public/config.json](ui/cabinet/public/config.json): `managerUrl` и `realm`. Файл читается при открытии страницы.

## Запуск рядом с уже работающим OpenRemote

На Linux-машине с Docker, с которой открывается `https://212.22.82.167`:

```bash
git clone -b cursor/boiler-cabinet-e92d https://github.com/VOL0DYA-AG/dashboard-service.git
cd dashboard-service
cp .env.example .env
```

В `.env` впишите пароль администратора этого OpenRemote в `OR_ADMIN_PASSWORD`. Адрес Manager уже стоит `https://212.22.82.167`.

Один раз создать realm `boiler`, оператора и демо-котельную. Температуры этот запуск не крутит (`SIM_LOOP=false`), чтобы не затереть живые датчики. Пароль существующего оператора не сбрасывается, пока не поставить `RESET_OPERATOR_PASSWORD=true`.

```bash
docker run --rm --env-file .env -v "$PWD":/src -w /src node:22-alpine \
  sh -c "npm install --prefix simulator && npm --prefix simulator start"
```

В `.env` адреса должны быть с `https://`, не с `http://`. Сертификат на этом IP самоподписанный, поэтому в том же файле нужна строка `NODE_TLS_REJECT_UNAUTHORIZED=0`. Без неё Node обрывает соединение и в логе остаётся только `fetch failed`.

Дождитесь `Данные заведены`. Заодно в клиент Keycloak `openremote` добавляется редирект `https://212.22.82.167/*`.

Соберите кабинет и положите его в уже запущенный Manager. Так страница и API на одном хосте, отдельные CORS не нужны.

```bash
npm --prefix ui/cabinet install
npm --prefix ui/cabinet run build
docker ps
```

Подставьте имя контейнера Manager:

```bash
docker exec ИМЯ_MANAGER mkdir -p /deployment/manager/app/cabinet
docker cp ui/cabinet/dist/. ИМЯ_MANAGER:/deployment/manager/app/cabinet
```

Если `console_config.json` на сервере ещё нет и телефонная консоль должна открывать только кабинет:

```bash
docker cp deployment/manager/app/console_config.json ИМЯ_MANAGER:/deployment/manager/app/console_config.json
```

Если файл уже есть, не заменяйте его целиком. Допишите `cabinet` в `allowedApps` и блок `apps.cabinet` из репозитория.

Откройте `https://212.22.82.167/cabinet/`. Логин оператора из `.env`, по умолчанию `operator` / `operator`, realm `boiler`.

Корень `https://212.22.82.167/` по-прежнему ведёт в Manager. Жильцу отдавайте ссылку с `/cabinet/`.

Если после копирования адрес отвечает 404, посмотрите `OR_CUSTOM_APP_DOCROOT` в контейнере. По умолчанию это `/deployment/manager/app`. Перезапуск нужен только если каталог появился впервые:

```bash
docker restart ИМЯ_MANAGER
```

### Кабинет отдельным сайтом

Если в контейнер Manager файлы положить нельзя, отдайте сборку своим nginx на порту 8090:

```bash
docker compose -f docker-compose.web.yml up -d --build
```

Страница будет на `http://<хост-кабинета>:8090/cabinet/`. В `config.json` уже указан `https://212.22.82.167`. На самом OpenRemote тогда нужны два разрешения:

- у клиента Keycloak `openremote` в realm `boiler` в Valid redirect URIs есть `http://<хост-кабинета>:8090/*`;
- у Manager в `OR_WEBSERVER_ALLOWED_ORIGINS` есть `http://<хост-кабинета>:8090`, после правки Manager перезапускают.

Копирование файлов в Manager этих шагов не требует.

## Локальный стенд, когда своего OpenRemote нет

Нужны свободные порты 80 и 443. На `212.22.82.167` эту команду не запускайте: она поднимет второй OpenRemote и займёт те же порты.

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f simulator
```

Дождитесь `Контур запущен`. Кабинет локального стенда: `https://localhost/cabinet/`, оператор `operator` / `operator`. Демо-контур пишет температуры; перед боевым контроллером его останавливают: `docker compose stop simulator`.

## Что видит человек

- **Обзор.** Объект, связь, улица, котёл (статус, подача, обратка, горелка, включение, предел подачи), контуры и ГВС. Уставка меняется кнопками на карточке. Режим выбирается в нижней панели: комфорт, эконом, антизамерзание, выключено.
- **Графики.** 6 часов, сутки, 7 дней. Линии можно сдвигать и масштабировать пальцем. История берётся из datapoints Manager.
- **Журнал.** Авария, снятие аварии, смена уставки и режима.

Эконом для помещения — это уставка минус 3 °C, для ГВС минус 8 °C. Антизамерзание держит помещение около 8 °C и ГВС около 15 °C. Выключенный контур тепла не просит.

## Как это встроено в OpenRemote

```text
телефон или браузер
        │
        ▼
https://хост/cabinet/          статические файлы кабинета
        │
        ▼
Manager  /api/boiler/...       активы, запись атрибутов, история
Keycloak /auth                 вход оператора
WebSocket /websocket/events    живые значения без перезагрузки
```

Manager отдаёт всё, что лежит в `/deployment/manager/app/<имя приложения>/`, по URL `/<имя>/`. Сборка кабинета попадает в каталог `cabinet`, поэтому адрес именно `/cabinet/`.

Файл `deployment/manager/app/console_config.json` говорит официальной консоли OpenRemote:

- открывать только приложение `cabinet`;
- realm для него — `boiler`;
- служебный `manager` в список приложений не показывать.

В консоли на телефоне вводят домен хоста, без пути `/cabinet/`. Консоль сама забирает `console_config.json` и открывает кабинет. Долгое нажатие на иконку консоли меняет домен, если конфиг это разрешает. В этом конфиге выбор приложения выключен.

`OR_ROOT_REDIRECT_PATH=/cabinet` в `docker-compose.yml` отправляет голый адрес хоста в кабинет.

Разработка интерфейса без пересборки контейнера:

```bash
npm install
npm --prefix ui/cabinet install
npm run dev
```

Это макет с живой моделью, OpenRemote не нужен: `http://localhost:9000/cabinet/`.

Против настоящего Manager:

```bash
npm --prefix ui/cabinet run dev
```

Vite проксирует `/api`, `/auth` и `/websocket` на `http://127.0.0.1`. Симулятор добавляет `http://localhost:9000/*` в разрешённые редиректы клиента `openremote`, иначе Keycloak не вернёт пользователя после входа.

Проверка модели котельной без браузера: `npm test`.

## Как подключить уже работающий OpenRemote

Исходники Manager менять не нужно. На сервере, где он уже запущен:

1. Соберите кабинет: `npm --prefix ui/cabinet install && npm --prefix ui/cabinet run build`.
2. Скопируйте `ui/cabinet/dist` в каталог custom-приложений так, чтобы получился путь `.../manager/app/cabinet/index.html`. У официального образа это `/deployment/manager/app`, переменная `OR_CUSTOM_APP_DOCROOT`.
3. Положите рядом `deployment/manager/app/console_config.json`.
4. В окружении Manager выставьте `OR_ROOT_REDIRECT_PATH=/cabinet`, если с корня хоста тоже нужно попадать в кабинет.
5. Перезапуск Manager нужен только если каталог `/deployment` смонтировали впервые. Сами файлы он читает с диска.

Версии в этом репозитории рассчитаны на Manager `1.30.1` и пакеты протокола той же линейки. На другом поколении Manager сверьте имена путей: запись атрибута, запрос datapoints и создание пользователя.

Кабинет ходит в API того же хоста, с которого открыт. Отдельный адрес бэкенда не прописывается.

## Как завести свои данные

Кабинет ищет обычные `ThingAsset`. Отдельный Java-тип не нужен. Связка такая: у каждого актива есть текстовый атрибут `cabinetKind`, котёл и контуры — дочерние активы объекта.

| Актив | cabinetKind | Что читается | Что пишет оператор |
| --- | --- | --- | --- |
| Объект | `plant` | `outdoorTemperature`, `online`, `alarmActive`, `alarmText`, `journal` | ничего |
| Котёл | `boiler` | `status`, `supplyTemperature`, `returnTemperature`, `flame` | `enabled`, `maxSupplySetpoint` |
| Контур | `circuit` | `roomTemperature`, `flowTemperature`, `pumpOn` | `setpoint`, `mode` |
| ГВС | `dhw` | `temperature`, `pumpOn` | `setpoint`, `mode` |

`status`: `heating`, `standby`, `off`, `fault`.

`mode`: `comfort`, `eco`, `antifreeze`, `off`.

Числа — JSON-числа, логические флаги — `true`/`false`, режим и статус — строки.

Демо-симулятор создаёт это дерево сам: объект «Котельная, дом 12», котёл, «Радиаторы», «Тёплый пол», «ГВС». Имена меняются переменной `PLANT_NAME`. Повторный запуск новое дерево не плодит, если объект с `cabinetKind=plant` уже есть.

Своя котельная заводится либо в Manager вручную, либо тем же JSON, что собирает `demoAssetTree()` в `contract/plant.ts`. Через API это выглядит так.

Токен администратора:

```bash
curl -s -X POST "https://localhost/auth/realms/master/protocol/openid-connect/token" \
  -d "client_id=openremote" \
  -d "grant_type=password" \
  -d "username=admin" \
  -d "password=secret"
```

Создать объект и затем дочерние активы с `parentId` объекта:

```bash
curl -s -X POST "https://localhost/api/boiler/asset" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @plant.json
```

Атрибут в теле актива:

```json
{
  "name": "Радиаторы",
  "type": "ThingAsset",
  "parentId": "ID_ОБЪЕКТА",
  "attributes": {
    "cabinetKind": {
      "type": "text",
      "value": "circuit",
      "meta": {
        "accessRestrictedRead": [{ "name": "accessRestrictedRead", "value": true }]
      }
    },
    "setpoint": {
      "type": "number",
      "value": 22,
      "meta": {
        "accessRestrictedRead": [{ "name": "accessRestrictedRead", "value": true }],
        "accessRestrictedWrite": [{ "name": "accessRestrictedWrite", "value": true }],
        "storeDataPoints": [{ "name": "storeDataPoints", "value": true }],
        "label": [{ "name": "label", "value": "Уставка" }]
      }
    }
  }
}
```

Смысл флагов:

- `accessRestrictedRead` — оператор с ролью `restricted_user` видит атрибут;
- `accessRestrictedWrite` — этому оператору можно его менять, ставьте только на уставки, режим и включение котла;
- `storeDataPoints` — значение попадает в историю и рисуется на графике.

Без `accessRestrictedRead` карточка для оператора будет пустой, даже если администратор значение видит. Без `storeDataPoints` график останется пустым: в атрибуте есть текущее значение, ряда нет.

Не ставьте `readOnly` на температуры, которые должен писать контроллер. Для REST-записи этот флаг закрывает атрибут всем, включая сервис. Оператор и так не сможет их менять: у него нет `accessRestrictedWrite` на этих полях.

Несколько котельных — несколько родительских активов с `cabinetKind=plant`. Кабинет сейчас показывает первую найденную. Разделение по домам делается разными пользователями: каждый связан только со своими активами.

## Права оператора

Симулятор создаёт пользователя так:

1. `POST /api/master/realm` с именем `boiler`, если realm ещё нет. Realm нужно создавать через Manager, не руками в Keycloak: вместе с ним появляются клиент `openremote` и роли.
2. `POST /api/master/user/boiler/users` — пользователь `operator`.
3. `PUT /api/master/user/boiler/reset-password/{id}` — пароль, тело `{ "type": "password", "value": "operator", "temporary": false }`.
4. `PUT /api/master/user/boiler/userRealmRoles/{id}` — тело `["restricted_user"]`.
5. `PUT /api/master/user/boiler/userRoles/{id}/openremote` — тело `["read:assets","write:attributes","read:alarms"]`.
6. `POST /api/boiler/asset/user/link` — связь пользователя с каждым активом дерева, включая детей. Связь только с родителем детей не открывает.

`restricted_user` видит лишь связанные активы и лишь атрибуты с флагами выше. Поэтому оператор меняет уставку и не может переписать измеренную температуру или чужую котельную.

Вход кабинета идёт в клиент Keycloak `openremote`, realm `boiler`, поток с PKCE. Для разработки клиенту нужны redirect URI `http://localhost:9000/*` и `https://localhost/*`. Симулятор дописывает их сам. На боевом хосте в клиенте должен быть `https://ваш-домен/*`.

## Обратная связь

Цепочка в демо такая.

1. Человек нажимает «+» у уставки радиаторов.
2. Кабинет сразу рисует новое число и делает `PUT /api/boiler/asset/{id контура}/attribute/setpoint` с телом `22.5`.
3. Manager проверяет, что пользователь связан с активом и у атрибута есть `accessRestrictedWrite`. Запись асинхронная: HTTP-ответ ещё не гарантия, что значение уже лежит в базе. Кабинет получает подтверждение по WebSocket.
4. Подписка кабинета: сокет `/websocket/events?Realm=boiler`, подпротокол `Bearer` и токен, первым сообщением `{ "eventType": "attribute", "subscriptionId": "cabinet" }`.
5. Симулятор раз в 5 секунд читает активы, забирает уставки и режимы, прогоняет шаг модели и записывает только измерения пакетом `PUT /api/boiler/asset/attributes`. Уставки он не отправляет.
6. Помещение на карточке ползёт к новой уставке, горелка и насос следуют за запросом тепла. Если котёл выключили при отрицательной улице, появляется авария. Смена уставки попадает в журнал.
7. Каждое записанное число с `storeDataPoints` остаётся точкой графика.

В бою симулятор заменяется контроллером. Роли те же, направление то же.

- Датчики и состояние котла пишет агент, правило или сервисный пользователь. Это атрибуты без `accessRestrictedWrite`: температуры, `status`, `flame`, `pumpOn`, `online`, `alarmText`.
- Уставки пишет кабинет. Контроллер обязан их читать и применять на оборудовании. Иначе экран изменится, а котёл нет.
- Удобный мост OpenRemote — agent link на атрибуте уставки: запись из кабинета уходит в протокол (MQTT, Modbus, HTTP — какой подключён к Manager), а протокол кладёт обратные измерения в атрибуты температур.
- Сервисному пользователю контроллера дайте роли `read:assets` и `write:attributes` и не давайте `restricted_user`. Иначе он сможет писать только в поля с `accessRestrictedWrite` и не обновит температуры.
- Подписка на события для контроллера та же, что у кабинета. Опрос `POST /api/boiler/asset/query` тоже годится, в демо он раз в 5 секунд.

Пакет измерений:

```json
[
  { "ref": { "id": "ID_КОТЛА", "name": "supplyTemperature" }, "value": 61.2 },
  { "ref": { "id": "ID_КОНТУРА", "name": "roomTemperature" }, "value": 21.4 },
  { "ref": { "id": "ID_КОНТУРА", "name": "pumpOn" }, "value": true }
]
```

История запрашивается отдельно по каждому ряду:

```bash
curl -s -X POST "https://localhost/api/boiler/asset/datapoint/ID/attribute/supplyTemperature" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"lttb","fromTimestamp":0,"toTimestamp":0,"amountOfPoints":240}'
```

Ответ кабинет понимает в трёх видах: `{ "x", "y" }`, `{ "timestamp", "value" }` и пара `[время, значение]`. Время — миллисекунды.

Симулятор при первом запуске пытается записать шесть часов истории вызовом с меткой времени: `PUT /api/boiler/asset/{id}/attribute/{имя}/{millis}`. Если конкретный Manager этот путь не принимает, график начнёт заполняться с живых шагов. На это уходит несколько минут.

## Консоль на телефоне

1. Поставьте официальное приложение OpenRemote Console.
2. В поле домена введите хост, например `boiler.example.com`. Путь `/cabinet/` не добавляют.
3. Консоль читает `console_config.json`, сама выбирает кабинет и realm `boiler`.
4. Логин тот же, `operator`.

С телефона без приложения достаточно той же ссылки в браузере. Её можно вынести на домашний экран: страница открывается на весь экран и рассчитана на узкую ширину.

## Что лежит в репозитории

- `ui/cabinet` — интерфейс, React и TypeScript.
- `contract/plant.ts` — имена атрибутов, разбор активов, модель шага и пределы уставок. Кабинет и симулятор используют один файл.
- `simulator` — наполнение realm и демо-контур.
- `deployment/manager/app/console_config.json` — поведение консоли.
- `docker-compose.yml` — proxy, PostgreSQL, Keycloak, сборка кабинета, Manager `1.30.1`, симулятор.

Служебный Manager по-прежнему на `/manager/`. Туда ходят наладчики. Жильцу и оператору котельной отдаёте только `/cabinet/`.
