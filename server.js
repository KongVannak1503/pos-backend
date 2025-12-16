require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { log } = require('console');

const app = express();
const server = http.createServer(app);

// Socket.IO setup with CORS
const io = new Server(server, {
    cors: {
        origin: '*', // Allow all connections
        methods: ['GET', 'POST']
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage
let currentOrder = null;
let orderHistory = [];

// Socket.IO namespace for customer display (Flutter connection)
const displayNamespace = io.of('/customer-display');

displayNamespace.on('connection', (socket) => {
    console.log(`✅ Flutter Customer display connected: ${socket.id}`);

    // Send connection status
    socket.emit('connection_status', {
        type: 'connection_status',
        data: {
            status: 'connected',
            timestamp: new Date().toISOString(),
        },
    });

    // Send current order if exists
    if (currentOrder) {
        socket.emit('orderUpdate', currentOrder);
    }

    socket.on('display_ack', (data) => {
        console.log('Display acknowledgment:', data);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Flutter Customer display disconnected: ${socket.id}`);
    });
});

// Broadcast to all connected Flutter displays
function broadcastToDisplays(event, data) {
    const clientsCount = displayNamespace.sockets.size;
    console.log(`📡 Broadcasting ${event} to ${clientsCount} display(s)`);
    displayNamespace.emit(event, data);
}

// Calculate order totals
function calculateOrderTotals() {
    if (!currentOrder) return;

    currentOrder.subtotal = currentOrder.items.reduce((sum, item) => sum + item.total, 0);
    currentOrder.tax = currentOrder.subtotal * 0.08975;
    currentOrder.total = currentOrder.subtotal + currentOrder.tax - currentOrder.discount;

    // Round to 2 decimal places
    currentOrder.subtotal = Math.round(currentOrder.subtotal * 100) / 100;
    currentOrder.tax = Math.round(currentOrder.tax * 100) / 100;
    currentOrder.total = Math.round(currentOrder.total * 100) / 100;
}

// ==================== POS ENDPOINTS ====================

// Add item to order
app.post('/api/pos/add-item', (req, res) => {
    // Ensure image is extracted
    const { id, name, price, quantity = 1, category, image } = req.body;

    if (!id || !name || !price) {
        return res.status(400).json({ error: 'Missing required fields: id, name, price' });
    }

    // Initialize order if doesn't exist
    if (!currentOrder) {
        currentOrder = {
            orderId: `ORD-${Date.now()}`,
            items: [],
            subtotal: 0,
            tax: 0,
            discount: 0,
            total: 0,
            paymentMethod: null,
            timestamp: new Date().toISOString(),
            customerInfo: null,
            status: 'in_progress'
        };
    }

    // Check if item already exists
    const existingItem = currentOrder.items.find(item => item.id === id);

    if (existingItem) {
        existingItem.quantity += quantity;
        existingItem.total = existingItem.quantity * existingItem.price;
        // Keep existing image if a new one isn't provided (safer handling)
        existingItem.image = image || existingItem.image;
    } else {
        // Ensure image is included in the new item object
        currentOrder.items.push({
            id,
            name,
            quantity,
            price,
            total: price * quantity,
            category: category || 'General',
            image: image || null
        });
    }

    calculateOrderTotals();

    // Broadcast to Flutter displays using Socket.IO
    broadcastToDisplays('orderUpdate', currentOrder);
    console.log(currentOrder);

    res.json({ success: true, order: currentOrder });
});

// Remove item
app.post('/api/pos/remove-item', (req, res) => {
    const { id } = req.body;

    if (!currentOrder) {
        return res.status(404).json({ error: 'No active order' });
    }

    currentOrder.items = currentOrder.items.filter(item => item.id !== id);
    calculateOrderTotals();

    broadcastToDisplays('orderUpdate', currentOrder);

    res.json({ success: true, order: currentOrder });
});

// Update quantity
app.post('/api/pos/update-quantity', (req, res) => {
    const { id, quantity } = req.body;

    if (!currentOrder) {
        return res.status(404).json({ error: 'No active order' });
    }

    const item = currentOrder.items.find(item => item.id === id);
    if (!item) {
        return res.status(404).json({ error: 'Item not found' });
    }

    if (quantity <= 0) {
        currentOrder.items = currentOrder.items.filter(item => item.id !== id);
    } else {
        item.quantity = quantity;
        item.total = item.price * quantity;
    }

    calculateOrderTotals();
    broadcastToDisplays('orderUpdate', currentOrder);

    res.json({ success: true, order: currentOrder });
});

// Apply discount
app.post('/api/pos/apply-discount', (req, res) => {
    const { discount } = req.body;

    if (!currentOrder) {
        return res.status(404).json({ error: 'No active order' });
    }

    currentOrder.discount = discount || 0;
    calculateOrderTotals();

    broadcastToDisplays('orderUpdate', currentOrder);

    res.json({ success: true, order: currentOrder });
});

// === NEW ENDPOINT: Save Completed Order (Required for 3-Step Client Payment) ===
app.post('/api/pos/save-completed-order', (req, res) => {
    if (!currentOrder) {
        return res.status(404).json({ error: 'No active order to save' });
    }

    const { paymentMethod, receivedAmount, change } = req.body;

    // Update current order details before saving
    currentOrder.paymentMethod = paymentMethod || 'cash';
    currentOrder.receivedAmount = receivedAmount;
    currentOrder.change = change;
    currentOrder.status = 'completed';
    currentOrder.completedAt = new Date().toISOString();

    // Save to history
    orderHistory.push({ ...currentOrder });

    // Note: We DO NOT clear currentOrder here. The client will call /clear next.

    res.json({ success: true, message: 'Order saved to history', orderId: currentOrder.orderId });
});
// ==============================================================================

// Complete order (Original logic - no longer used by the new client flow)
app.post('/api/pos/complete-order', (req, res) => {
    const { paymentMethod, customerInfo } = req.body;

    if (!currentOrder) {
        return res.status(404).json({ error: 'No active order' });
    }

    currentOrder.paymentMethod = paymentMethod || 'cash';
    currentOrder.customerInfo = customerInfo || null;
    currentOrder.status = 'completed';
    currentOrder.completedAt = new Date().toISOString();

    orderHistory.push({ ...currentOrder });

    broadcastToDisplays('status_update', {
        type: 'status_update',
        data: {
            orderId: currentOrder.orderId,
            status: 'completed',
            message: 'Order completed',
            estimatedTime: 0
        }
    });

    const completedOrder = { ...currentOrder };

    setTimeout(() => {
        currentOrder = null;
        broadcastToDisplays('display_message', {
            type: 'display_message',
            data: { message: 'clear' }
        });
    }, 3000);

    res.json({ success: true, order: completedOrder });
});

// Cancel order
app.post('/api/pos/cancel-order', (req, res) => {
    if (!currentOrder) {
        return res.status(404).json({ error: 'No active order' });
    }

    currentOrder = null;

    broadcastToDisplays('display_message', {
        type: 'display_message',
        data: { message: 'clear' }
    });

    res.json({ success: true, message: 'Order cancelled' });
});

// Get current order
app.get('/api/pos/current-order', (req, res) => {
    res.json({ order: currentOrder });
});

// ==================== CUSTOMER DISPLAY ENDPOINTS ====================

// Send order to display
app.post('/api/customer-display/order', (req, res) => {
    try {
        const order = req.body;
        console.log('Received order:', order);

        if (!order || !order.items || !Array.isArray(order.items)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid order data',
                details: 'Missing required field: items',
            });
        }

        currentOrder = order;
        console.log(order);

        // Broadcast new order event
        broadcastToDisplays('orderUpdate', order);

        res.status(200).json({
            success: true,
            message: 'Order sent to customer display successfully',
            orderId: order.orderId,
            displayStatus: 'active',
        });
    } catch (error) {
        console.error('Error sending order:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
});


// Update order status
app.put('/api/customer-display/order/:orderId/status', (req, res) => {
    try {
        const { orderId } = req.params;
        const { status, estimatedTime, message } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: status',
            });
        }

        // Broadcast status update event
        broadcastToDisplays('status_update', {
            type: 'status_update',

            data: {
                orderId,
                status,
                estimatedTime,
                message,
            },
        });

        res.status(200).json({
            success: true,
            message: 'Order status updated successfully',
            orderId,
            newStatus: status,
        });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
});

// === NEW ENDPOINT: Custom Status for Flutter UI (e.g., preparing-cancel) ===
app.put('/api/customer-display/order/:orderId/custom-status', (req, res) => {
    try {
        const { orderId } = req.params;
        const { status, message } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'Missing required field: status' });
        }

        // Broadcast the custom status update event
        broadcastToDisplays('status_update', {
            type: 'status_update',
            data: {
                orderId,
                status, // e.g., "preparing-cancel"
                message: message || 'Custom status broadcasted',
            },
        });

        res.status(200).json({
            success: true,
            message: 'Custom status broadcasted successfully',
            orderId,
            newStatus: status,
        });
    } catch (error) {
        console.error('Error broadcasting custom status:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
});
// ========================================================================


// Clear display
app.post('/api/customer-display/clear', (req, res) => {
    try {
        const { reason } = req.body || {};

        currentOrder = null;

        // Broadcast display clear event
        broadcastToDisplays('display_message', {
            type: 'display_message',
            data: {
                message: 'clear',
                reason,
            },
        });

        res.status(200).json({
            success: true,
            message: 'Customer display cleared successfully',
        });
    } catch (error) {
        console.error('Error clearing display:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
        });
    }
});

// Get current display
app.get('/api/customer-display/current', (req, res) => {
    res.json({ order: currentOrder });
});

// ==================== ORDER HISTORY ====================

app.get('/api/orders/history', (req, res) => {
    res.json({ orders: orderHistory });
});

app.get('/api/orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const order = orderHistory.find(o => o.orderId === orderId);

    if (order) {
        res.json({ order });
    } else {
        res.status(404).json({ error: 'Order not found' });
    }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeOrder: currentOrder ? currentOrder.orderId : null,
        connectedDisplays: displayNamespace.sockets.size
    });
});

// Serve web POS interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 POS Backend Server Started!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📱 Web POS Interface: http://localhost:${PORT}`);
    console.log(`📺 Socket.IO Endpoint: ws://localhost:${PORT}/customer-display`);
    console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
    console.log(`💚 Health Check: http://localhost:${PORT}/health`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 Available Endpoints:');
    console.log('   POST   /api/pos/add-item (Now supports image field)');
    console.log('   POST   /api/pos/save-completed-order (NEW)');
    console.log('   PUT    /api/customer-display/order/:orderId/custom-status (NEW)');
    console.log('   ... (Existing endpoints)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎯 Waiting for Flutter customer display to connect...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});