const express = require('express');
const path    = require('path');
const router  = express.Router();

// ─── Template engine setup (called once from backend.js context) ───────────────
// We export a function that receives the app so we can set view engine there.
// But since this is a router, we configure it in backend.js.

// Static files for the frontend
router.use('/static', express.static(path.join(__dirname, 'static')));

// ─── Page Routes ──────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.render('dashboard', { title: 'Dashboard', activePage: 'dashboard' });
});

router.get('/dashboard', (req, res) => {
  res.render('dashboard', { title: 'Dashboard', activePage: 'dashboard' });
});

router.get('/rooms', (req, res) => {
  res.render('rooms', { title: 'Rooms Overview', activePage: 'rooms' });
});

router.get('/tenant/:id', (req, res) => {
  res.render('tenant', { title: 'Tenant Detail', activePage: 'rooms', tenantId: req.params.id });
});

router.get('/add-tenant', (req, res) => {
  res.render('add_tenant', { title: 'Add New Tenant', activePage: 'rooms' });
});

router.get('/bond', (req, res) => {
  res.render('bond', { title: 'Bond Manager', activePage: 'bond' });
});

router.get('/expenses', (req, res) => {
  res.render('expenses', { title: 'Expenses', activePage: 'expenses' });
});

router.get('/database', (req, res) => {
  res.render('database', { title: 'Database', activePage: 'database' });
});

module.exports = router;
