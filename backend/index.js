require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// قاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());

// Helper: التحقق من JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ========== Auth Endpoints ==========
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [username, hashed]);
    const userId = result.rows[0].id;
    await pool.query('INSERT INTO players (user_id, gold, inventory, fields, animals) VALUES ($1, $2, $3, $4, $5)', 
      [userId, 0, { Wheat: 3, Carrot: 2 }, [null, null, null, null], []]);
    const token = jwt.sign({ id: userId, username }, process.env.JWT_SECRET);
    res.json({ token, username, userId });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username exists' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username }, process.env.JWT_SECRET);
    res.json({ token, username, userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== بيانات اللاعب ==========
app.get('/api/user/data', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT gold, score, inventory, fields, animals, game_data FROM players WHERE user_id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/user/add-gold', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: 'Missing amount' });
  try {
    await pool.query('UPDATE players SET gold = gold + $1 WHERE user_id = $2', [amount, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== المزرعة ==========
app.post('/api/farm/plant', authenticateToken, async (req, res) => {
  const { fieldIndex, cropKey, buyPrice } = req.body;
  if (fieldIndex === undefined || !cropKey) return res.status(400).json({ error: 'Invalid data' });
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT gold, fields FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const player = playerRes.rows[0];
    const fields = player.fields;
    if (fields[fieldIndex] !== null) throw new Error('Field occupied');
    if (player.gold < buyPrice) throw new Error('Not enough gold');
    const newGold = player.gold - buyPrice;
    fields[fieldIndex] = { crop: cropKey, plantedAt: Date.now() };
    await pool.query('UPDATE players SET gold = $1, fields = $2 WHERE user_id = $3', [newGold, fields, req.user.id]);
    await pool.query('COMMIT');
    res.json({ success: true, gold: newGold, fields });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/farm/harvest', authenticateToken, async (req, res) => {
  const { fieldIndex, crop, sellPrice } = req.body;
  if (fieldIndex === undefined) return res.status(400).json({ error: 'Missing field' });
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT gold, score, inventory, fields FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const player = playerRes.rows[0];
    const fields = player.fields;
    const field = fields[fieldIndex];
    if (!field || field.crop !== crop) throw new Error('No crop');
    const growTimes = { Wheat:5, Carrot:4, Potato:6, Tomato:7, Corn:8, Pepper:9, Strawberry:10, Watermelon:12 };
    const elapsed = (Date.now() - field.plantedAt) / 1000;
    if (elapsed < growTimes[crop]) throw new Error('Not ready');
    const newGold = player.gold + sellPrice;
    const newScore = player.score + 1;
    let inventory = player.inventory;
    inventory[crop] = (inventory[crop] || 0) + 1;
    fields[fieldIndex] = null;
    await pool.query('UPDATE players SET gold = $1, score = $2, inventory = $3, fields = $4 WHERE user_id = $5', 
      [newGold, newScore, inventory, fields, req.user.id]);
    await pool.query('COMMIT');
    res.json({ success: true, gold: newGold, score: newScore, inventory, fields });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// ========== السوق ==========
app.get('/api/market/listings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.id, l.seller_id, u.username as seller_name, l.item_name, l.quantity, l.price_per_unit, l.listed_at
      FROM market_listings l
      JOIN users u ON l.seller_id = u.id
      WHERE l.status = 'active'
      ORDER BY l.listed_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/market/create', authenticateToken, async (req, res) => {
  const { item, quantity, pricePerUnit } = req.body;
  if (!item || !quantity || !pricePerUnit) return res.status(400).json({ error: 'Missing data' });
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT inventory FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    let inventory = playerRes.rows[0].inventory;
    if (!inventory[item] || inventory[item] < quantity) throw new Error('Not enough items');
    inventory[item] -= quantity;
    await pool.query('UPDATE players SET inventory = $1 WHERE user_id = $2', [inventory, req.user.id]);
    await pool.query('INSERT INTO market_listings (seller_id, item_name, quantity, price_per_unit) VALUES ($1, $2, $3, $4)', 
      [req.user.id, item, quantity, pricePerUnit]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/market/buy', authenticateToken, async (req, res) => {
  const { listingId, quantity, pricePerUnit, itemName, sellerId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'Missing listing' });
  try {
    await pool.query('BEGIN');
    const buyerRes = await pool.query('SELECT gold, inventory FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const buyer = buyerRes.rows[0];
    const totalCost = quantity * pricePerUnit;
    if (buyer.gold < totalCost) throw new Error('Not enough gold');
    const sellerRes = await pool.query('SELECT gold FROM players WHERE user_id = $1 FOR UPDATE', [sellerId]);
    const sellerGold = sellerRes.rows[0].gold;
    await pool.query('UPDATE players SET gold = $1 WHERE user_id = $2', [sellerGold + totalCost, sellerId]);
    const newGold = buyer.gold - totalCost;
    let buyerInv = buyer.inventory;
    buyerInv[itemName] = (buyerInv[itemName] || 0) + quantity;
    await pool.query('UPDATE players SET gold = $1, inventory = $2 WHERE user_id = $3', [newGold, buyerInv, req.user.id]);
    await pool.query('UPDATE market_listings SET status = $1 WHERE id = $2', ['sold', listingId]);
    await pool.query('COMMIT');
    res.json({ success: true, gold: newGold, inventory: buyerInv });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// ========== تحويل الأموال ==========
app.post('/api/transfer', authenticateToken, async (req, res) => {
  const { toUsername, amountFils } = req.body;
  if (!toUsername || !amountFils) return res.status(400).json({ error: 'Missing data' });
  try {
    await pool.query('BEGIN');
    const toUserRes = await pool.query('SELECT id FROM users WHERE username = $1', [toUsername]);
    if (toUserRes.rows.length === 0) throw new Error('Recipient not found');
    const toUserId = toUserRes.rows[0].id;
    if (toUserId === req.user.id) throw new Error('Cannot transfer to self');
    const fromPlayerRes = await pool.query('SELECT gold FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const fromGold = fromPlayerRes.rows[0].gold;
    if (fromGold < amountFils) throw new Error('Insufficient gold');
    await pool.query('UPDATE players SET gold = gold - $1 WHERE user_id = $2', [amountFils, req.user.id]);
    await pool.query('UPDATE players SET gold = gold + $1 WHERE user_id = $2', [amountFils, toUserId]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// ========== النقل ==========
app.get('/api/shipments/pending', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*, u_from.username as from_name, u_to.username as to_name
      FROM shipments s
      JOIN users u_from ON s.from_user_id = u_from.id
      JOIN users u_to ON s.to_user_id = u_to.id
      WHERE s.status = 'pending'
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/shipments/accept', authenticateToken, async (req, res) => {
  const { shipmentId } = req.body;
  try {
    await pool.query('BEGIN');
    const shipmentRes = await pool.query('SELECT * FROM shipments WHERE id = $1 AND status = $2 FOR UPDATE', [shipmentId, 'pending']);
    if (shipmentRes.rows.length === 0) throw new Error('Shipment not available');
    await pool.query('UPDATE shipments SET status = $1, assigned_to = $2, assigned_at = NOW() WHERE id = $3', 
      ['in_transit', req.user.id, shipmentId]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/shipments/complete', authenticateToken, async (req, res) => {
  const { shipmentId } = req.body;
  try {
    await pool.query('BEGIN');
    const shipmentRes = await pool.query('SELECT * FROM shipments WHERE id = $1 AND assigned_to = $2 AND status = $3 FOR UPDATE', 
      [shipmentId, req.user.id, 'in_transit']);
    if (shipmentRes.rows.length === 0) throw new Error('Shipment not in progress');
    const shipment = shipmentRes.rows[0];
    const receiverRes = await pool.query('SELECT inventory FROM players WHERE user_id = $1 FOR UPDATE', [shipment.to_user_id]);
    let receiverInv = receiverRes.rows[0].inventory;
    receiverInv[shipment.item_name] = (receiverInv[shipment.item_name] || 0) + shipment.quantity;
    await pool.query('UPDATE players SET inventory = $1 WHERE user_id = $2', [receiverInv, shipment.to_user_id]);
    await pool.query('UPDATE players SET gold = gold + $1 WHERE user_id = $2', [shipment.reward, req.user.id]);
    await pool.query('UPDATE shipments SET status = $1 WHERE id = $2', ['delivered', shipmentId]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// ========== المصنع ==========
app.get('/api/factory/machines', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT game_data->\'machines\' as machines FROM players WHERE user_id = $1', [req.user.id]);
    res.json({ machines: result.rows[0]?.machines || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/factory/buy-machine', authenticateToken, async (req, res) => {
  const { machineType, cost } = req.body;
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT gold, game_data FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (playerRes.rows[0].gold < cost) throw new Error('Not enough gold');
    let gameData = playerRes.rows[0].game_data || {};
    let machines = gameData.machines || [];
    machines.push({ type: machineType, status: 'idle', startTime: null });
    gameData.machines = machines;
    await pool.query('UPDATE players SET gold = gold - $1, game_data = $2 WHERE user_id = $3', [cost, gameData, req.user.id]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/factory/start-production', authenticateToken, async (req, res) => {
  const { machineIndex, inputItem } = req.body;
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT game_data, inventory FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    let gameData = playerRes.rows[0].game_data;
    let inventory = playerRes.rows[0].inventory;
    let machines = gameData.machines;
    if (!machines || !machines[machineIndex] || machines[machineIndex].status === 'busy') throw new Error('Machine not available');
    if (!inventory[inputItem] || inventory[inputItem] < 1) throw new Error('Missing input material');
    inventory[inputItem]--;
    machines[machineIndex].status = 'busy';
    machines[machineIndex].startTime = Date.now();
    gameData.machines = machines;
    await pool.query('UPDATE players SET game_data = $1, inventory = $2 WHERE user_id = $3', [gameData, inventory, req.user.id]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

// ========== الحيوانات ==========
app.post('/api/farm/buy-animal', authenticateToken, async (req, res) => {
  const { animalKey, price } = req.body;
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT gold, animals FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (playerRes.rows[0].gold < price) throw new Error('Not enough gold');
    const newGold = playerRes.rows[0].gold - price;
    let animals = playerRes.rows[0].animals;
    const interval = animalKey === 'Chicken' ? 10000 : (animalKey === 'Cow' ? 20000 : 15000);
    animals.push({ type: animalKey, lastCollect: Date.now() - interval });
    await pool.query('UPDATE players SET gold = $1, animals = $2 WHERE user_id = $3', [newGold, animals, req.user.id]);
    await pool.query('COMMIT');
    res.json({ success: true, gold: newGold, animals });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/farm/collect-animal', authenticateToken, async (req, res) => {
  const { animalIndex } = req.body;
  try {
    await pool.query('BEGIN');
    const playerRes = await pool.query('SELECT gold, score, inventory, animals FROM players WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    let animals = playerRes.rows[0].animals;
    const animal = animals[animalIndex];
    if (!animal) throw new Error('Animal not found');
    const animalDef = { Chicken: { product: 'بيض', sellProduct: 3000, interval: 10000 }, Cow: { product: 'حليب', sellProduct: 8000, interval: 20000 }, Sheep: { product: 'صوف', sellProduct: 6000, interval: 15000 } }[animal.type];
    const now = Date.now();
    if (now - animal.lastCollect < animalDef.interval) throw new Error('Not ready yet');
    const newGold = playerRes.rows[0].gold + animalDef.sellProduct;
    const newScore = playerRes.rows[0].score + 1;
    let inventory = playerRes.rows[0].inventory;
    inventory[animalDef.product] = (inventory[animalDef.product] || 0) + 1;
    animals[animalIndex].lastCollect = now;
    await pool.query('UPDATE players SET gold = $1, score = $2, inventory = $3, animals = $4 WHERE user_id = $5', 
      [newGold, newScore, inventory, animals, req.user.id]);
    await pool.query('COMMIT');
    res.json({ success: true, gold: newGold, score: newScore, inventory, animals });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
