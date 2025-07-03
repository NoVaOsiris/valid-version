const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const Excel = require('exceljs');

const app = express();
const PORT = 3000;

// Middleware
app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite' }),
    secret: 'pos-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 }
}));
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB init
const db = new sqlite3.Database('sales.db', err => {
    if (err) console.error('DB error', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);
    db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    price INTEGER
  )`);
    db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    product_id INTEGER,
    quantity INTEGER,
    sale_time TEXT
  )`);
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    product_id INTEGER,
    date TEXT,
    opening_balance INTEGER,
    receipt INTEGER,
    transfer INTEGER,
    write_off INTEGER,
    closing_balance INTEGER,
    UNIQUE(seller_id, product_id, date)
  )`);
});

// Role check
function requireRole(role) {
    return (req, res, next) => {
        const user = req.session.user;
        if (!user || (role && user.role !== role)) {
            return res.status(401).json({ error: 'Недостаточно прав' });
        }
        next();
    };
}

// Auth
app.post('/api/login', (req, res) => {
    const { name, password } = req.body;
    db.get(`SELECT * FROM sellers WHERE name=? AND password=?`, [name, password], (err, row) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        if (!row) return res.status(401).json({ error: 'Неверные данные' });
        req.session.user = { id: row.id, name: row.name, role: row.role };
        res.json(req.session.user);
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// Products
app.get('/api/products', requireRole(), (req, res) => {
    db.all(`SELECT * FROM products ORDER BY name`, (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json(rows);
    });
});

app.post('/api/products', requireRole('admin'), (req, res) => {
    const { id, name, price } = req.body;
    if (id) {
        db.run(`UPDATE products SET name=?, price=? WHERE id=?`, [name, price, id], err => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true });
        });
    } else {
        db.run(`INSERT INTO products (name, price) VALUES (?,?)`, [name, price], function (err) {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true, id: this.lastID });
        });
    }
});

app.delete('/api/products/:id', requireRole('admin'), (req, res) => {
    db.run(`DELETE FROM products WHERE id=?`, [req.params.id], err => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json({ success: true });
    });
});

// Sales
app.post('/api/sales', requireRole(), (req, res) => {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Нет товаров' });
    const time = new Date().toISOString();
    const stmt = db.prepare(`INSERT INTO sales (seller_id, product_id, quantity, sale_time) VALUES (?,?,?,?)`);
    db.serialize(() => {
        items.forEach(i => stmt.run(req.session.user.id, i.product_id, i.quantity, time));
        stmt.finalize(err => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true });
        });
    });
});

app.get('/api/sales', requireRole('admin'), (req, res) => {
    const { seller_id, date } = req.query;
    let sql = `
    SELECT s.name AS point, p.name AS product, sa.quantity, p.price,
           (p.price * sa.quantity) AS sum,
           datetime(sa.sale_time,'localtime') AS time
    FROM sales sa
    JOIN sellers s ON s.id = sa.seller_id
    JOIN products p ON p.id = sa.product_id`;
    const cond = [], params = [];
    if (seller_id) { cond.push('sa.seller_id = ?'); params.push(seller_id); }
    if (date) { cond.push("date(sa.sale_time)=?"); params.push(date); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY sa.sale_time DESC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json(rows);
    });
});

// Excel: Sales
app.get('/api/sales-export.xlsx', requireRole('admin'), (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).send('Укажите дату');
    const sql = `
    SELECT s.name AS seller, p.name AS product, sa.quantity, p.price,
           (sa.quantity * p.price) AS sum,
           datetime(sa.sale_time,'localtime') AS time
    FROM sales sa
    JOIN sellers s ON s.id = sa.seller_id
    JOIN products p ON p.id = sa.product_id
    WHERE date(sa.sale_time) = ?
    ORDER BY sa.sale_time`;
    db.all(sql, [date], async (err, rows) => {
        if (err) return res.status(500).send('DB error');
        const wb = new Excel.Workbook();
        const ws = wb.addWorksheet('Sales');
        ws.columns = [
            { header: 'Продавец', key: 'seller', width: 20 },
            { header: 'Товар', key: 'product', width: 25 },
            { header: 'Кол-во', key: 'quantity', width: 10 },
            { header: 'Цена', key: 'price', width: 10 },
            { header: 'Сумма', key: 'sum', width: 12 },
            { header: 'Время', key: 'time', width: 20 }
        ];
        ws.getRow(1).font = { bold: true };
        ws.autoFilter = { from: 'A1', to: 'F1' };
        let total = 0;
        rows.forEach(r => {
            ws.addRow(r);
            total += r.sum;
        });
        const totalRow = ws.addRow({ seller: '', product: '', quantity: '', price: '', sum: total, time: 'ИТОГО' });
        totalRow.font = { bold: true };
        totalRow.alignment = { horizontal: 'right' };
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="sales-${date}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    });
});
app.get('/api/inventory-all.xlsx', requireRole('admin'), (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).send('Укажите дату');

    const sql = `
    SELECT s.name AS seller, p.name AS product,
           i.opening_balance, i.receipt, i.transfer,
           i.write_off, i.closing_balance
    FROM inventory i
    JOIN sellers s ON s.id = i.seller_id
    JOIN products p ON p.id = i.product_id
    WHERE date = ?
    ORDER BY s.name, p.name
  `;

    db.all(sql, [date], async (err, rows) => {
        if (err) return res.status(500).send('DB error');

        const wb = new Excel.Workbook();
        const ws = wb.addWorksheet('Inventory');

        ws.columns = [
            { header: 'Продавец', key: 'seller', width: 20 },
            { header: 'Товар', key: 'product', width: 25 },
            { header: 'Нач. остаток', key: 'opening_balance', width: 12 },
            { header: 'Поступл.', key: 'receipt', width: 10 },
            { header: 'Перемещение', key: 'transfer', width: 12 },
            { header: 'Списание', key: 'write_off', width: 10 },
            { header: 'Кон. остаток', key: 'closing_balance', width: 12 }
        ];
        ws.getRow(1).font = { bold: true };
        ws.autoFilter = { from: 'A1', to: 'G1' };

        rows.forEach(r => ws.addRow(r));

        res.setHeader('Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',
            `attachment; filename="inventory-${date}.xlsx"`);

        await wb.xlsx.write(res);
        res.end();
    });
});

// Inventory
app.get('/api/inventory-fill', requireRole(), (req, res) => {
    const seller_id = req.session.user.id;
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'Укажите дату' });
    const sql = `
    SELECT p.id, p.name,
           COALESCE(i.opening_balance, '') AS opening_balance,
           COALESCE(i.receipt, '') AS receipt,
           COALESCE(i.transfer, '') AS transfer,
           COALESCE(i.write_off, '') AS write_off,
           COALESCE(i.closing_balance, '') AS closing_balance
    FROM products p
    LEFT JOIN inventory i
      ON i.product_id = p.id AND i.seller_id = ? AND i.date = ?
    ORDER BY p.name`;
    db.all(sql, [seller_id, date], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        res.json(rows);
    });
});

app.post('/api/inventory', requireRole(), (req, res) => {
    const seller_id = req.session.user.id;
    const { date, rows } = req.body;
    if (!date || !Array.isArray(rows)) return res.status(400).json({ error: 'Неверные данные' });

    const stmt = db.prepare(`
    INSERT INTO inventory (seller_id, product_id, date, opening_balance, receipt, transfer, write_off, closing_balance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(seller_id, product_id, date)
    DO UPDATE SET
      opening_balance = excluded.opening_balance,
      receipt = excluded.receipt,
      transfer = excluded.transfer,
      write_off = excluded.write_off,
      closing_balance = excluded.closing_balance
  `);

    db.serialize(() => {
        rows.forEach(r => {
            stmt.run(
                seller_id, r.product_id, date,
                r.opening || 0,
                r.receipt || 0,
                r.transfer || 0,
                r.write_off || 0,
                r.closing || 0
            );
        });
        stmt.finalize(err => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json({ success: true });
        });
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 POS-сервер запущен: http://localhost:${PORT}`);
});
