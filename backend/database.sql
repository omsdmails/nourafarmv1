-- جدول المستخدمين
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- جدول بيانات اللاعبين
CREATE TABLE IF NOT EXISTS players (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gold INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  inventory JSONB DEFAULT '{}',
  fields JSONB DEFAULT '[null,null,null,null]',
  animals JSONB DEFAULT '[]',
  game_data JSONB DEFAULT '{}'
);

-- جدول إعلانات السوق
CREATE TABLE IF NOT EXISTS market_listings (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price_per_unit INTEGER NOT NULL,
  listed_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active'
);

-- جدول طلبات النقل
CREATE TABLE IF NOT EXISTS shipments (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  from_location JSONB,
  to_location JSONB,
  status TEXT DEFAULT 'pending',
  assigned_to INTEGER REFERENCES users(id),
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
