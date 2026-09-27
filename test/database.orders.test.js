const { createFakeConnection } = require('./helpers/fakeMysql');
// Jest hoists mock factories and only allows identifiers prefixed with "mock".
const mockConnection = createFakeConnection();
const connection = mockConnection;

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(async () => mockConnection),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn(async (value) => `hashed-${value}`),
  compare: jest.fn(async (value, hash) => hash === `hashed-${value}`),
}));

const config = require('../src/config.js');
const { DB } = require('../src/database/database.js');

const MENU_SELECT = 'SELECT * FROM menu';
const MENU_INSERT = 'INSERT INTO menu (title, description, image, price) VALUES (?, ?, ?, ?)';
const ORDER_ITEMS_SELECT = 'SELECT id, menuId, description, price FROM orderItem WHERE orderId=?';
const DINER_ORDER_INSERT = 'INSERT INTO dinerOrder (dinerId, franchiseId, storeId, date) VALUES (?, ?, ?, now())';
const ORDER_ITEM_INSERT = 'INSERT INTO orderItem (orderId, menuId, description, price) VALUES (?, ?, ?, ?)';
const MENU_ID_SELECT = 'SELECT id FROM menu WHERE id=?';

function orderListSql(page) {
  const offset = (page - 1) * [config.db.listPerPage];
  return `SELECT id, franchiseId, storeId, date FROM dinerOrder WHERE dinerId=? LIMIT ${offset},${config.db.listPerPage}`;
}

beforeAll(async () => {
  await DB.initialized;
});

beforeEach(() => {
  const fresh = createFakeConnection();
  connection.execute = fresh.execute;
  connection.query = fresh.query;
  connection.end = fresh.end;
});

describe('getMenu', () => {
  test('selects every menu row and ends the connection', async () => {
    const rows = [
      { id: 1, title: 'Veggie', description: 'Garden', image: 'veg.png', price: 0.003 },
      { id: 2, title: 'Pepperoni', description: 'Classic', image: 'pep.png', price: 0.004 },
    ];
    connection.execute.mockResolvedValueOnce([rows, []]);

    const result = await DB.getMenu();

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(MENU_SELECT, undefined);
    expect(result).toBe(rows);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates an execute failure and still ends the connection', async () => {
    const failure = new Error('menu select failed');
    connection.execute.mockRejectedValueOnce(failure);

    await expect(DB.getMenu()).rejects.toBe(failure);

    expect(connection.execute).toHaveBeenCalledWith(MENU_SELECT, undefined);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });
});

describe('addMenuItem', () => {
  test('inserts title, description, image, and price and returns the item with insertId', async () => {
    const item = {
      title: 'Margherita',
      description: 'Tomato and basil',
      image: 'marg.png',
      price: 0.005,
    };
    connection.execute.mockResolvedValueOnce([{ insertId: 7 }, undefined]);

    const result = await DB.addMenuItem(item);

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(MENU_INSERT, [item.title, item.description, item.image, item.price]);
    expect(result).toEqual({ ...item, id: 7 });
    expect(item.id).toBeUndefined();
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates an insert failure and still ends the connection', async () => {
    const failure = new Error('menu insert failed');
    connection.execute.mockRejectedValueOnce(failure);

    await expect(
      DB.addMenuItem({ title: 'A', description: 'B', image: 'C', price: 1 }),
    ).rejects.toBe(failure);

    expect(connection.end).toHaveBeenCalledTimes(1);
  });
});

describe('getOrders', () => {
  test('defaults to page 1, limits with offset 0, and loads items for each order', async () => {
    const user = { id: 42, name: 'Sam' };
    const orders = [
      { id: 10, franchiseId: 1, storeId: 2, date: '2024-01-01' },
      { id: 11, franchiseId: 1, storeId: 3, date: '2024-01-02' },
    ];
    const firstItems = [{ id: 100, menuId: 1, description: 'Veggie', price: 0.003 }];
    const secondItems = [{ id: 101, menuId: 2, description: 'Pepperoni', price: 0.004 }];
    connection.execute
      .mockResolvedValueOnce([orders, []])
      .mockResolvedValueOnce([firstItems, []])
      .mockResolvedValueOnce([secondItems, []]);

    const result = await DB.getOrders(user);

    expect(config.db.listPerPage).toBe(10);
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(1, orderListSql(1), [user.id]);
    expect(connection.execute.mock.calls[0][0]).toContain('LIMIT 0,10');
    expect(connection.execute).toHaveBeenNthCalledWith(2, ORDER_ITEMS_SELECT, [10]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, ORDER_ITEMS_SELECT, [11]);
    expect(result).toEqual({
      dinerId: 42,
      orders: [
        { ...orders[0], items: firstItems },
        { ...orders[1], items: secondItems },
      ],
      page: 1,
    });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('page 2 uses offset 10 and still loads that page of items', async () => {
    const user = { id: 7 };
    const orders = [{ id: 30, franchiseId: 4, storeId: 5, date: '2024-02-02' }];
    const items = [{ id: 300, menuId: 3, description: 'Cheese', price: 0.002 }];
    connection.execute.mockResolvedValueOnce([orders, []]).mockResolvedValueOnce([items, []]);

    const result = await DB.getOrders(user, 2);

    expect(connection.execute).toHaveBeenNthCalledWith(1, orderListSql(2), [user.id]);
    expect(connection.execute.mock.calls[0][0]).toBe(
      'SELECT id, franchiseId, storeId, date FROM dinerOrder WHERE dinerId=? LIMIT 10,10',
    );
    expect(connection.execute).toHaveBeenNthCalledWith(2, ORDER_ITEMS_SELECT, [30]);
    expect(result).toEqual({
      dinerId: 7,
      orders: [{ ...orders[0], items }],
      page: 2,
    });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('does not query items when the order list is empty', async () => {
    const user = { id: 42 };
    connection.execute.mockResolvedValueOnce([[], []]);

    const result = await DB.getOrders(user);

    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledWith(orderListSql(1), [user.id]);
    expect(connection.execute.mock.calls.some((call) => String(call[0]).includes('orderItem'))).toBe(false);
    expect(result).toEqual({ dinerId: 42, orders: [], page: 1 });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates an execute failure and still ends the connection', async () => {
    const failure = new Error('order select failed');
    connection.execute.mockRejectedValueOnce(failure);

    await expect(DB.getOrders({ id: 42 })).rejects.toBe(failure);

    expect(connection.execute).toHaveBeenCalledWith(orderListSql(1), [42]);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates an item select failure after the order select and still ends the connection', async () => {
    const user = { id: 42 };
    const orders = [
      { id: 10, franchiseId: 1, storeId: 2, date: '2024-01-01' },
      { id: 11, franchiseId: 1, storeId: 3, date: '2024-01-02' },
    ];
    const failure = new Error('order item select failed');
    connection.execute.mockResolvedValueOnce([orders, []]).mockRejectedValueOnce(failure);

    await expect(DB.getOrders(user, 1)).rejects.toBe(failure);

    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenNthCalledWith(1, orderListSql(1), [user.id]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, ORDER_ITEMS_SELECT, [10]);
    expect(orders[0].items).toBeUndefined();
    expect(connection.end).toHaveBeenCalledTimes(1);
  });
});

describe('addDinerOrder', () => {
  test('inserts the order, looks up one menu id, and returns the order with that insert id', async () => {
    const user = { id: 5 };
    const order = {
      franchiseId: 2,
      storeId: 3,
      items: [{ menuId: 9, description: 'Veggie', price: 0.003 }],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([[{ id: 99 }], []])
      .mockResolvedValueOnce([{ insertId: 15 }, undefined]);

    const result = await DB.addDinerOrder(user, order);

    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(1, DINER_ORDER_INSERT, [user.id, order.franchiseId, order.storeId]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, MENU_ID_SELECT, [9]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, ORDER_ITEM_INSERT, [7, 99, 'Veggie', 0.003]);
    expect(result).toEqual({ ...order, id: 7 });
    expect(order.id).toBeUndefined();
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('looks up and inserts each item when the order has two items', async () => {
    const user = { id: 5 };
    const order = {
      franchiseId: 2,
      storeId: 3,
      items: [
        { menuId: 9, description: 'Veggie', price: 0.003 },
        { menuId: 8, description: 'Pepperoni', price: 0.004 },
      ],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([[{ id: 21 }], []])
      .mockResolvedValueOnce([{ insertId: 15 }, undefined])
      .mockResolvedValueOnce([[{ id: 22 }], []])
      .mockResolvedValueOnce([{ insertId: 16 }, undefined]);

    const result = await DB.addDinerOrder(user, order);

    expect(connection.execute).toHaveBeenCalledTimes(5);
    expect(connection.execute).toHaveBeenNthCalledWith(1, DINER_ORDER_INSERT, [5, 2, 3]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, MENU_ID_SELECT, [9]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, ORDER_ITEM_INSERT, [7, 21, 'Veggie', 0.003]);
    expect(connection.execute).toHaveBeenNthCalledWith(4, MENU_ID_SELECT, [8]);
    expect(connection.execute).toHaveBeenNthCalledWith(5, ORDER_ITEM_INSERT, [7, 22, 'Pepperoni', 0.004]);
    expect(result).toEqual({ ...order, id: 7 });
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('throws No ID found when a menu id is missing and still ends the connection', async () => {
    const user = { id: 5 };
    const order = {
      franchiseId: 2,
      storeId: 3,
      items: [{ menuId: 404, description: 'Missing', price: 1 }],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([[], []]);

    await expect(DB.addDinerOrder(user, order)).rejects.toThrow(new Error('No ID found'));

    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenNthCalledWith(1, DINER_ORDER_INSERT, [5, 2, 3]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, MENU_ID_SELECT, [404]);
    expect(connection.execute.mock.calls.some((call) => String(call[0]).includes('INSERT INTO orderItem'))).toBe(false);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('inserts the first order item, then throws when the second menu id is missing', async () => {
    const user = { id: 5 };
    const order = {
      franchiseId: 2,
      storeId: 3,
      items: [
        { menuId: 9, description: 'Veggie', price: 0.003 },
        { menuId: 404, description: 'Missing', price: 0.004 },
      ],
    };
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([[{ id: 21 }], []])
      .mockResolvedValueOnce([{ insertId: 15 }, undefined])
      .mockResolvedValueOnce([[], []]);

    await expect(DB.addDinerOrder(user, order)).rejects.toThrow(new Error('No ID found'));

    expect(connection.execute).toHaveBeenCalledTimes(4);
    expect(connection.execute).toHaveBeenNthCalledWith(1, DINER_ORDER_INSERT, [5, 2, 3]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, MENU_ID_SELECT, [9]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, ORDER_ITEM_INSERT, [7, 21, 'Veggie', 0.003]);
    expect(connection.execute).toHaveBeenNthCalledWith(4, MENU_ID_SELECT, [404]);
    expect(connection.execute.mock.calls.filter((call) => call[0] === ORDER_ITEM_INSERT)).toHaveLength(1);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates an orderItem insert failure after the menu id lookup and still ends the connection', async () => {
    const user = { id: 5 };
    const order = {
      franchiseId: 2,
      storeId: 3,
      items: [{ menuId: 9, description: 'Veggie', price: 0.003 }],
    };
    const failure = new Error('order item insert failed');
    connection.execute
      .mockResolvedValueOnce([{ insertId: 7 }, undefined])
      .mockResolvedValueOnce([[{ id: 99 }], []])
      .mockRejectedValueOnce(failure);

    await expect(DB.addDinerOrder(user, order)).rejects.toBe(failure);

    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(connection.execute).toHaveBeenNthCalledWith(1, DINER_ORDER_INSERT, [5, 2, 3]);
    expect(connection.execute).toHaveBeenNthCalledWith(2, MENU_ID_SELECT, [9]);
    expect(connection.execute).toHaveBeenNthCalledWith(3, ORDER_ITEM_INSERT, [7, 99, 'Veggie', 0.003]);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  test('propagates a dinerOrder insert failure and still ends the connection', async () => {
    const failure = new Error('diner order insert failed');
    connection.execute.mockRejectedValueOnce(failure);

    await expect(
      DB.addDinerOrder({ id: 5 }, { franchiseId: 2, storeId: 3, items: [] }),
    ).rejects.toBe(failure);

    expect(connection.execute).toHaveBeenCalledWith(DINER_ORDER_INSERT, [5, 2, 3]);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });
});

describe('getOffset', () => {
  test('page 1 with no page size is 0 and page 3 with 10 is 20', () => {
    // config.db.listPerPage is the number 10. [10] and '10' both coerce to 10,
    // so those inputs cannot tell (page - 1) * [listPerPage] from (page - 1) * listPerPage.
    expect(config.db.listPerPage).toBe(10);
    expect(DB.getOffset(1)).toBe((1 - 1) * [undefined]);
    expect(DB.getOffset(1)).toBe(0);
    expect(DB.getOffset(3, 10)).toBe((3 - 1) * [10]);
    expect(DB.getOffset(3, 10)).toBe(20);
    expect(DB.getOffset(3, '10')).toBe(20);
    expect(DB.getOffset(3, '10')).toBe((3 - 1) * '10');
  });

  test('a boolean page size follows array stringification, not numeric multiplication', () => {
    // [true] stringifies to "true", and Number("true") is NaN. (3 - 1) * true is 2.
    expect(DB.getOffset(3, true)).toBe((3 - 1) * [true]);
    expect(DB.getOffset(3, true)).toBeNaN();
    expect((3 - 1) * true).toBe(2);
  });
});
