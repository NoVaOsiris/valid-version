require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const Excel = require('exceljs');

const app = express();
const PORT = 3000;

// DB connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Middleware
app.use(session({
    store: new pgSession({ pool }),
    secret: process.env.SESSION_SECRET || 'pos-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 }
}));
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB init
(async () => {
    const initSQL = `
    CREATE TABLE IF NOT EXISTS sellers (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        price INTEGER
    );
    CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        seller_id INTEGER REFERENCES sellers(id),
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER,
        sale_time TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        seller_id INTEGER REFERENCES sellers(id),
        product_id INTEGER REFERENCES products(id),
        date DATE,
        opening_balance INTEGER,
        receipt INTEGER,
        transfer INTEGER,
        write_off INTEGER,
        closing_balance INTEGER,
        UNIQUE(seller_id, product_id, date)
    );
    INSERT INTO sellers (name, password, role) VALUES
        ('mechnikova','1234','seller'),
        ('borodinka','1234','seller'),
        ('merkury','1234','seller'),
        ('pochta','1234','seller'),
        ('obzhorka','1234','seller'),
        ('pyshka','1234','seller'),
        ('klio','1234','seller'),
        ('admin','admin','admin')
    ON CONFLICT (name) DO NOTHING;`;

    try {
        await pool.query(initSQL);
    } catch (e) {
        console.error('DB init error', e);
    }
})();

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
app.post('/api/login', async (req, res) => {
    const { name, password } = req.body;
    try {
        const { rows } = await pool.query(
            'SELECT * FROM sellers WHERE name=$1 AND password=$2',
            [name, password]
        );
        const row = rows[0];
        if (!row) return res.status(401).json({ error: 'Неверные данные' });
        req.session.user = { id: row.id, name: row.name, role: row.role };
        res.json(req.session.user);
    } catch (err) {
        res.status(500).json({ error: 'DB error' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// Products
app.get('/api/products', requireRole(), async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'DB error' });
    }
});

app.post('/api/products', requireRole('admin'), async (req, res) => {
    const { id, name, price } = req.body;
    try {
        if (id) {
            await pool.query('UPDATE products SET name=$1, price=$2 WHERE id=$3', [name, price, id]);
            res.json({ success: true });
        } else {
            const { rows } = await pool.query('INSERT INTO products (name, price) VALUES ($1,$2) RETURNING id', [name, price]);
            res.json({ success: true, id: rows[0].id });
        }
    } catch (err) {
        res.status(500).json({ error: 'DB error' });
    }
});

app.delete('/api/products/:id', requireRole('admin'), async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'DB error' });
    }
});

// Sales
app.post('/api/sales', requireRole(), async (req, res) => {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'Нет товаров' });
    const time = new Date().toISOString();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const i of items) {
            await client.query(
                'INSERT INTO sales (seller_id, product_id, quantity, sale_time) VALUES ($1,$2,$3,$4)',
                [req.session.user.id, i.product_id, i.quantity, time]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'DB error' });
    } finally {
        client.release();
    }
});

app.get('/api/sales', requireRole('admin'), async (req, res) => {
    const { seller_id, date } = req.query;
    let sql = `
    SELECT s.name AS seller, p.name AS product, sa.quantity, p.price,
           (p.price * sa.quantity) AS sum,
           sa.sale_time AT TIME ZONE 'UTC' AT TIME ZONE 'localtime' AS time
    FROM sales sa
    JOIN sellers s ON s.id = sa.seller_id
    JOIN products p ON p.id = sa.product_id`;
    const cond = [], params = [];
    if (seller_id) { cond.push('sa.seller_id = $' + (params.length + 1)); params.push(seller_id); }
    if (date) { cond.push('date(sa.sale_time) = $' + (params.length + 1)); params.push(date); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY sa.sale_time DESC';
    try {
        const { rows } = await pool.query(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'DB error' });
    }
});

// Excel: Sales
app.get('/api/sales-export.xlsx', requireRole('admin'), async (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).send('Укажите дату');
    const sql = `
    SELECT s.name AS seller, p.name AS product, sa.quantity, p.price,
           (sa.quantity * p.price) AS sum,
           sa.sale_time AT TIME ZONE 'UTC' AT TIME ZONE 'localtime' AS time
    FROM sales sa
    JOIN sellers s ON s.id = sa.seller_id
    JOIN products p ON p.id = sa.product_id
    WHERE date(sa.sale_time) = $1
    ORDER BY sa.sale_time`;
    try {
        const { rows } = await pool.query(sql, [date]);
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
    } catch (err) {
        res.status(500).send('DB error');
    }
});
app.get('/api/inventory-all.xlsx', requireRole('admin'), async (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).send('Укажите дату');

    const sql = `
    SELECT s.name AS seller, p.name AS product,
           i.opening_balance, i.receipt, i.transfer,
           i.write_off, i.closing_balance
    FROM inventory i
    JOIN sellers s ON s.id = i.seller_id
    JOIN products p ON p.id = i.product_id
    WHERE date = $1
    ORDER BY s.name, p.name
  `;

    try {
        const { rows } = await pool.query(sql, [date]);

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
    } catch (err) {
        res.status(500).send('DB error');
    }
});

// Inventory
app.get('/api/inventory-fill', requireRole(), async (req, res) => {
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
      ON i.product_id = p.id AND i.seller_id = $1 AND i.date = $2
    ORDER BY p.name`;
    try {
        const { rows } = await pool.query(sql, [seller_id, date]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'DB error' });
    }
});

app.post('/api/inventory', requireRole(), async (req, res) => {
    const seller_id = req.session.user.id;
    const { date, rows } = req.body;
    if (!date || !Array.isArray(rows)) return res.status(400).json({ error: 'Неверные данные' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const r of rows) {
            await client.query(
                `INSERT INTO inventory (seller_id, product_id, date, opening_balance, receipt, transfer, write_off, closing_balance)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT(seller_id, product_id, date)
                 DO UPDATE SET
                   opening_balance = EXCLUDED.opening_balance,
                   receipt = EXCLUDED.receipt,
                   transfer = EXCLUDED.transfer,
                   write_off = EXCLUDED.write_off,
                   closing_balance = EXCLUDED.closing_balance`,
                [
                    seller_id,
                    r.product_id,
                    date,
                    r.opening || 0,
                    r.receipt || 0,
                    r.transfer || 0,
                    r.write_off || 0,
                    r.closing || 0
                ]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'DB error' });
    } finally {
        client.release();
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 POS-сервер запущен: http://localhost:${PORT}`);
});
