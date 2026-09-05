-- Seeds one package + all current services/add-ons so the backend's
-- server-side price calculation matches the existing hardcoded PRICES
-- object in index.html exactly. Run after schema.sql:
--   wrangler d1 execute kremchympe-db --file=./seed.sql

INSERT INTO packages (name, description, base_price, active, highlighted, sort_order)
VALUES ('Krem Chympe Adventure & Camping', 'Adventure trek, cave expedition, and optional overnight camping.', 0, 1, 1, 0);
-- base_price is 0 because every line item here is an optional add-on service
-- priced per the toggles/counters on the form — the "package" itself is a
-- container, not a flat fee. Local Guide is modeled as a mandatory service
-- below so it always appears in the total, matching current behavior.

-- id 1 assumed for the single package on a fresh DB; adjust if you've already
-- inserted other packages first (check with: select id from packages;)

INSERT INTO services (package_id, name, price, active, sort_order) VALUES
  (1, 'Local Guide (mandatory)', 1500, 1, 1),
  (1, '4x4 Jeep (per group)', 4000, 1, 2),
  (1, 'Adventure Activities (per person)', 1200, 1, 3),
  (1, 'Veg Thali', 300, 1, 4),
  (1, 'Chicken Thali', 300, 1, 5),
  (1, 'Pork Thali', 300, 1, 6),
  (1, 'Camping Tent (per tent)', 1000, 1, 7),
  (1, 'Camping Meals (per person)', 300, 1, 8),
  (1, 'Overnight Guide (mandatory with camping)', 1000, 1, 9),
  (1, 'Fresh Bamboo Chicken (500g)', 699, 1, 10),
  (1, 'Fresh Bamboo Chicken (1kg)', 890, 1, 11),
  (1, 'Fresh Bamboo Pork (500g)', 799, 1, 12),
  (1, 'Fresh Bamboo Pork (1kg)', 1000, 1, 13),
  (1, 'Roasted Pork Belly Salad (500g)', 599, 1, 14),
  (1, 'Roasted Pork Belly Salad (1kg)', 900, 1, 15),
  (1, 'Boiled Fish (Zero Oil)', 250, 1, 16),
  (1, 'Veg Bamboo Sabji', 300, 1, 17),
  (1, 'Boiled Egg', 20, 1, 18),
  (1, 'Bamboo Chai', 20, 1, 19);
