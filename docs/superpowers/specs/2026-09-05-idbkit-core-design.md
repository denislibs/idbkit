# idbkit — ядро: дизайн

Дата: 2026-09-05
Статус: на ревью

## 1. Что это

`idbkit` — семейство маленьких модулей над IndexedDB с одним крошечным ядром.
Ядро даёт типизированную схему, миграции, транзакции, базовые операции,
курсоры и событие изменений с кросс-табным broadcast. Все остальные модули
(query builder, адаптеры фреймворков, очередь, кэш, тест-утилиты) строятся
поверх ядра и живут в отдельных subpath-экспортах.

Этот документ описывает **только ядро** — первую итерацию.

### Не входит в первую итерацию

- Query builder (`idbkit/query`)
- Адаптеры React / Vue / Svelte (`idbkit/react` и т.д.)
- Outbox-очередь (`idbkit/queue`)
- TTL-кэш (`idbkit/cache`)
- Тестовые утилиты (`idbkit/testing`)
- Вложенные key path вроде `'profile.email'`
- Подписки с произвольным предикатом по значению записи
- Синхронизация порядка событий между вкладками

## 2. Ограничения и бюджеты

| Параметр | Значение |
|---|---|
| Размер ядра (entry `idbkit`), gzip | ≤ 3 КБ, проверяется `size-limit` в CI |
| Runtime-зависимости | 0 |
| Формат | ESM only, TypeScript, `.d.ts` в пакете |
| Целевые браузеры | Нативные `Promise`, async-итераторы, `BroadcastChannel`. Без полифиллов |
| Node | Только для тестов через `fake-indexeddb` |

## 3. Структура пакета

```
idbkit/
  package.json        exports: { ".": "./dist/index.js" }  (+ subpaths позже)
  src/
    index.ts          публичный реэкспорт
    open.ts           openDB, upgrade, синхронизация структуры
    schema.ts         только типы: StoreConfig, Schema, вывод ключей и индексов
    tx.ts             Transaction: get/put/delete/getAll/count/clear
    cursor.ts         iterate — async-итератор над курсором
    range.ts          конверсия { gt, gte, lt, lte } | value → IDBKeyRange
    events.ts         subscribe, сбор изменений в транзакции, BroadcastChannel
    errors.ts         IdbError, SchemaError
  test/               Vitest + fake-indexeddb
  docs/superpowers/specs/
```

Инструменты: `tsup` для сборки, `vitest` для тестов, `size-limit` для бюджета,
`typescript` strict.

## 4. Схема и типы

Схема описывается обычным объектом. Типы записей передаются generic'ом,
имена полей в `key` и `indexes` проверяются компилятором как `keyof Record`.

```ts
type Schema = { users: User; posts: Post };

const db = await openDB<Schema>('app', {
  version: 2,
  stores: {
    users: {
      key: 'id',
      indexes: {
        byEmail: { path: 'email', unique: true },
        byAge: 'age',
      },
    },
    posts: {
      key: 'id',
      autoIncrement: true,
      indexes: {
        byAuthor: 'authorId',
        byAuthorDate: ['authorId', 'createdAt'],   // составной индекс
      },
    },
  },
  migrations: {
    2: async (tx) => { /* миграция данных на версию 2 */ },
  },
  broadcast: true,   // по умолчанию true
});
```

### 4.1 Конфигурация store

```ts
type IndexPath<R> = keyof R & string | (keyof R & string)[];

type IndexConfig<R> =
  | IndexPath<R>
  | { path: IndexPath<R>; unique?: boolean; multiEntry?: boolean };

type StoreConfig<R> = {
  key: keyof R & string;
  autoIncrement?: boolean;
  indexes?: Record<string, IndexConfig<R>>;
};

type OpenOptions<S> = {
  version: number;
  stores: { [K in keyof S]: StoreConfig<S[K]> };
  migrations?: Record<number, Migration>;
  broadcast?: boolean;
  onBlocked?: () => void;         // другая вкладка держит старую версию
  onVersionChange?: () => void;   // другая вкладка открыла новую версию
};
```

### 4.2 Выводимые типы

- `StoreName<S> = keyof S & string`
- `KeyOf<S, N>` — тип поля `S[N][stores[N].key]`. Для `autoIncrement` без
  явного значения — `number`.
- `IndexName<S, N>` — ключи `stores[N].indexes`.
- `IndexKey<S, N, I>` — тип значения индекса: тип поля, либо кортеж типов для
  составного.

Опечатка в имени поля (`indexes: { byEmail: 'emial' }`) — ошибка компиляции.

## 5. Открытие и миграции

`openDB` вызывает `indexedDB.open(name, version)`.

### 5.1 Порядок при `upgradeneeded`

1. Проверки конфигурации (выполняются **до** open, синхронно):
   - любой ключ `migrations` больше `version` → `SchemaError`;
   - `version < 1` → `SchemaError`.
2. Внутри транзакции апгрейда, по возрастанию, для каждой версии `v` в
   диапазоне `(oldVersion, newVersion]`, у которой есть `migrations[v]`,
   вызвать `migrations[v](tx)`. Пропущенные версии допустимы.
3. Синхронизация структуры под схему:
   - создать stores, которых нет;
   - для каждого store из схемы: создать недостающие индексы, удалить
     индексы, которых нет в схеме;
   - stores, которых нет в схеме, **не удалять**. В dev (не `production`)
     писать `console.warn` с именем store.

Миграции идут **до** синхронизации структуры, чтобы миграция могла
работать со старыми stores и индексами до их удаления.

### 5.2 Транзакция миграции

`Migration = (tx: UpgradeTransaction) => void | Promise<void>`

`UpgradeTransaction` — обычная `Transaction` (см. §6) без типизации по схеме
(`store: string`, значения `unknown`), плюс:

- `tx.deleteStore(name: string): void`
- `tx.oldVersion: number`, `tx.newVersion: number`

Ограничение IndexedDB: все `await` внутри миграции должны быть только на
операциях этой транзакции. Любой внешний `await` (fetch, таймер) закроет
транзакцию, и следующая операция бросит `IdbError`. Это документируется.

### 5.3 События

- `onBlocked` — вызывается при `blocked`: другая вкладка держит старую
  версию. `openDB` при этом продолжает ждать.
- `onVersionChange` — вызывается при `versionchange` на уже открытой БД.
  Ядро ничего не закрывает само; приложение решает, вызвать ли `db.close()`.

## 6. Операции и транзакции

### 6.1 Одиночные операции (создают транзакцию под капотом)

```ts
db.get(store, key): Promise<Record | undefined>
db.getAll(store, opts?): Promise<Record[]>
db.getAllKeys(store, opts?): Promise<Key[]>
db.count(store, opts?): Promise<number>
db.put(store, value): Promise<Key>
db.add(store, value): Promise<Key>
db.delete(store, key): Promise<void>
db.clear(store): Promise<void>
db.iterate(store, opts?): AsyncIterable<Cursor>
db.close(): void
```

`opts` для чтений:

```ts
type QueryOptions<S, N> = {
  index?: IndexName<S, N>;
  range?: Range<IndexKey | KeyOf>;
  limit?: number;
  direction?: 'next' | 'prev' | 'nextunique' | 'prevunique';
};

type Range<K> = K | { gt?: K; gte?: K; lt?: K; lte?: K };
```

Значение без объекта — равенство (`IDBKeyRange.only`). Пустой объект — весь
диапазон.

### 6.2 Явные транзакции

```ts
const tx = db.transaction(['users', 'posts'], 'readwrite');
await tx.put('users', u);
await tx.put('posts', p);
await tx.done;
```

- `tx` имеет те же методы, что и `db`, но только для перечисленных stores
  (проверяется типами).
- `tx.done: Promise<void>` — резолвится на `complete`, реджектится на
  `abort` и `error`.
- `tx.abort(): void`.

### 6.3 Курсоры

```ts
for await (const cur of db.iterate('users', { index: 'byAge', range: { gte: 18 } })) {
  cur.key; cur.primaryKey; cur.value;
  await cur.update(newValue);
  await cur.delete();
}
```

`break` из цикла прерывает курсор. `iterate` доступен и на `tx`.

### 6.4 Ошибки

- `IdbError extends Error` — поле `cause` (исходный `DOMException`), поле
  `store?: string`, поле `op?: string`.
- `SchemaError extends Error` — ошибки конфигурации до открытия.

Все реджекты промисов ядра — экземпляры этих классов.

## 7. Событие изменений

### 7.1 Модель события

```ts
type Change = {
  store: string;
  keys: Key[] | null;              // null → clear, изменилось всё
  entries?: ChangeEntry[];          // по одному на ключ, если keys !== null
  source: 'local' | 'remote';       // remote — пришло из другой вкладки
};

type ChangeEntry = {
  key: Key;
  before?: IndexValues;             // до изменения; нет у add
  after?: IndexValues;              // после изменения; нет у delete
};

type IndexValues = Record<string, unknown>;  // имя поля → значение
```

В `IndexValues` попадают **только** поля, упомянутые в `key` и `indexes`
данного store. Полная запись в событие не попадает никогда — это держит
событие маленьким и делает его безопасным для передачи между вкладками.

### 7.2 Когда и как собирается

- Каждая транзакция `readwrite` ведёт список изменений по своим stores.
- `put`/`add`/`delete`/`clear`/`cursor.update`/`cursor.delete` добавляют
  запись в список.
- После `complete` транзакции: список отдаётся локальным подписчикам и, если
  `broadcast !== false`, уходит в `BroadcastChannel`.
- После `abort` — список отбрасывается, ничего не рассылается.

### 7.3 Дочитывание старого значения

`before` нужен только диапазонным подпискам (§7.4), чтобы заметить запись,
которая **вышла** из диапазона. Поэтому:

- перед `put` и `delete` ядро делает `get` старой записи **только если** на
  этом store есть хотя бы одна активная диапазонная подписка в этой вкладке;
- иначе лишнего чтения нет, `before` отсутствует.

Кросс-табные подписчики получают `before` уже вычисленным вкладкой-источником,
если он там был. Если вкладка-источник `before` не читала (у неё нет
диапазонных подписок), диапазонные подписчики в других вкладках получают
событие **без** `before` и обязаны считать его релевантным (консервативная
инвалидация). Это документированный компромисс.

### 7.4 Подписки

```ts
db.subscribe(store, listener): Unsubscribe
db.subscribe(store, { key }, listener): Unsubscribe
db.subscribe(store, { index, range }, listener): Unsubscribe

type Listener = (change: Change) => void;
```

Правила доставки:

| Подписка | Получает событие, если |
|---|---|
| весь store | любое изменение store |
| `{ key }` | `keys === null` или `keys` содержит `key` |
| `{ index, range }` | `keys === null`, или у какой-то записи `before` или `after` попадает в диапазон по полям индекса, или у записи нет `before` при `source: 'remote'` |

Перед вызовом listener `keys` и `entries` фильтруются под подписку: listener
видит только релевантные ключи. Для подписки на весь store — без фильтрации.

Listener вызывается синхронно после `complete`, ошибки внутри listener
ловятся и логируются, не ломают остальных подписчиков.

### 7.5 BroadcastChannel

- Имя канала: `idbkit:<dbName>`.
- Сообщение: массив `Change` без поля `source`; получатель проставляет
  `'remote'`.
- Один канал на экземпляр `db`, закрывается в `db.close()`.
- Если `BroadcastChannel` недоступен — broadcast молча выключен.
- `broadcast: false` в `openDB` отключает и отправку, и приём.

## 8. Тестирование

Стек: Vitest, `fake-indexeddb` (импорт `fake-indexeddb/auto` в setup).
Тесты типов через `expectTypeOf` и `// @ts-expect-error`.

Обязательные сценарии:

1. **Типы:** опечатка в `key`/`indexes` — ошибка компиляции; `KeyOf` и
   `IndexKey` выводятся верно, включая составные.
2. **Апгрейд 1 → 3** с миграциями `2` и `3`: порядок вызова, `oldVersion` и
   `newVersion` внутри, данные после миграции.
3. **Синхронизация структуры:** удалённый из схемы индекс исчезает, новый
   появляется, store вне схемы остаётся.
4. **Проверки конфигурации:** миграция с ключом больше `version` бросает
   `SchemaError` до открытия.
5. **Составной индекс:** `getAll` с диапазоном по кортежу.
6. **Транзакции:** `abort` реджектит `done`; операции после закрытия
   транзакции дают `IdbError` с `cause`.
7. **Курсор:** `break` останавливает итерацию; `update`/`delete` через
   курсор попадают в событие изменений.
8. **События:** listener вызывается после commit и не вызывается после
   abort; фильтрация по ключу; фильтрация по диапазону, включая случай
   «запись вышла из диапазона» с `before`; `clear` даёт `keys: null`.
9. **Дочитывание:** без диапазонных подписок `put` не делает `get`
   (проверяется через spy на `fake-indexeddb`); с подпиской — делает.
10. **Broadcast:** два экземпляра `openDB` одной БД в одном процессе,
    изменение в одном приходит в другой с `source: 'remote'`;
    `broadcast: false` отключает.
11. **Размер:** `size-limit` ≤ 3 КБ gzip для `dist/index.js`.

## 9. Открытые решения, принятые в этом документе

- Стиль API — имя store первым аргументом (как `idb`), а не `db.users.get`.
  Один стиль для одиночных операций и транзакций, минимальный runtime.
- Миграции — декларативная структура плюс миграции данных по целевой версии.
  Stores вне схемы не удаляются автоматически.
- Подписки — три уровня: store, ключ, диапазон по индексу. Предикат по
  произвольному значению не поддерживается.
- Broadcast — в ядре, включён по умолчанию, несёт только индексируемые поля.
