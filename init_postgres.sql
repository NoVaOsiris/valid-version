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
ON CONFLICT (name) DO NOTHING;
