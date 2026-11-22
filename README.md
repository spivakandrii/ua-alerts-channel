# Тривоги → Telegram-канал

Ланцюжок: **cron-job.org** (щохвилини) → **GitHub Actions** → `check-alerts.mjs` перевіряє тривоги по областях → якщо щось змінилося, публікує пост у **Telegram-канал**.

- Джерело даних: `https://ubilling.net.ua/aerialalerts/` (неофіційне, без ключа).
- Стан між запусками зберігається в кеші GitHub Actions (`state.json`), тому пости з'являються лише тоді, коли тривога починається або закінчується.
- Якщо джерело недоступне (наприклад, `429 Too Many Requests`), запуск пропускається без змін.

> ⚠️ Неофіційне джерело може запізнюватися. Канал не замінює офіційних застосунків («Повітряна тривога», «Дія»).

## Налаштування

### 1. Канал
1. Створіть канал у Telegram.
2. Додайте бота в **адміністратори** каналу з правом публікувати повідомлення.
3. ID каналу: `@username` для публічного каналу або числовий `-100…` для приватного.

### 2. Секрети репозиторію
`Settings → Secrets and variables → Actions`:
- **Secrets:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`
- **Variables** (необов'язково): `REGIONS`, наприклад `м. Київ,Київська область`

### 3. cron-job.org
1. На GitHub створіть **fine-grained token**: `Settings → Developer settings → Fine-grained tokens`. Дайте доступ лише до цього репозиторію з правом **Actions: Read and write**.
2. На cron-job.org створіть завдання:
   - **URL:** `https://api.github.com/repos/<owner>/<repo>/actions/workflows/alerts.yml/dispatches`
   - **Розклад:** щохвилини
   - **Метод:** `POST`
   - **Заголовки:**
     - `Authorization: Bearer <ваш fine-grained token>`
     - `Accept: application/vnd.github+json`
     - `User-Agent: cron-job.org`
   - **Тіло запиту:** `{"ref":"main"}`
   - Успішна відповідь: `204 No Content`.

Запасний тригер `schedule` у workflow запускає перевірку раз на 5 хвилин навіть без cron-job.org (GitHub часто запускає його із запізненням).

## Локальна перевірка
```powershell
$env:DRY_RUN = "1"; node check-alerts.mjs
```
