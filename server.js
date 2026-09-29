require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const ADYEN_API_KEY = process.env.ADYEN_API_KEY;
const ADYEN_ENDPOINT = process.env.ADYEN_ENDPOINT || 'https://terminal-api-test.adyen.com/sync';
const DONATION_AMOUNT = parseInt(process.env.DONATION_AMOUNT || '10', 10);
const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';

// Terminal Fleet Configuration (Includes your 3 physical terminals)
const TERMINAL_REGISTRY = {
  'booth-1':  { id: 'booth-1',  name: 'Booth 1 - P400+ (807243868)', poiid: 'P400Plus-807243868', taps: 0 },
  'booth-2':  { id: 'booth-2',  name: 'Booth 2 - P400+ (807102793)',  poiid: 'P400Plus-807102793',     taps: 0 },
  'booth-3':  { id: 'booth-3',  name: 'Booth 3 - V400m (452806254)', poiid: 'V400m-452806254',    taps: 0 },
  'booth-4':  { id: 'booth-4',  name: 'Booth 4 - V400cPlus (452859670)', poiid: 'V400cPlus-452859670', taps: 0 },
  'booth-5':  { id: 'booth-5',  name: 'Booth 5 - P400+ (806092751)',poiid: 'P400Plus-806092751', taps: 0 },
  'booth-6':  { id: 'booth-6',  name: 'Booth 6 - P400+ (807095942)',poiid: 'P400Plus-807095942', taps: 0 },
  'booth-7':  { id: 'booth-7',  name: 'Booth 7 - S1F2 (000158254409646)',poiid: 'S1F2-000158254409646', taps: 0 },
  'booth-8':  { id: 'booth-8',  name: 'Booth 8 - S1F2 (000158254409654)',poiid: 'S1F2-000158254409654', taps: 0 },
  'booth-9':  { id: 'booth-9',  name: 'Booth 9 - M400 (807353540)',        poiid: 'M400-807353540', taps: 0 },
  'booth-10': { id: 'booth-10', name: 'Booth 10 - Future',           poiid: 'P400Plus-807243877', taps: 0 }
};

// Global Charity State formatted for the Stage Dashboard
let charityState = {
  totalAmountUSD: 0,
  totalDonors: 0,
  totalUSD: 0,
  terminals: TERMINAL_REGISTRY,
  recentDonations: []
};

// Nexo ServiceID must be unique per message (max 10 alphanumeric chars)
function generateServiceID() {
  return String(Date.now()).slice(-8) + Math.floor(Math.random() * 90 + 10);
}

// Helper: Send EnableService AbortTransaction with custom display message
async function sendEnableServiceAbort(poiid, saleId) {
  const serviceId = generateServiceID();
  const enablePayload = {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: "3.0",
        MessageClass: "Service",
        MessageCategory: "EnableService",
        MessageType: "Request",
        ServiceID: serviceId,
        SaleID: saleId,
        POIID: poiid
      },
      EnableServiceRequest: {
        TransactionAction: "AbortTransaction",
        DisplayOutput: {
          Device: "CustomerDisplay",
          InfoQualify: "Display",
          OutputContent: {
            PredefinedContent: {
              ReferenceID: "AcceptedAnimated"
            },
            OutputFormat: "Text",
            OutputText: [
              { Text: "Thank you for donating" },
              { Text: "We logged your contribution" }
            ]
          }
        }
      }
    }
  };

  console.log(`\n📤 [ENABLE SERVICE] Sending custom Thank You screen to ${poiid}...`);
  try {
    const res = await fetch(ADYEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-API-key': ADYEN_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(enablePayload)
    });
    const enableJson = await res.json();
    console.log(`✨ [ENABLE SERVICE RESPONSE] Status: ${res.status}`);
    console.log(JSON.stringify(enableJson, null, 2));
  } catch (err) {
    console.error(`⚠️ Could not send EnableService completion to ${poiid}:`, err.message);
  }
}

// Redirect root to POS app
app.get('/', (req, res) => {
  res.redirect('/pos.html');
});

// Get terminal registry for frontend dropdown
app.get('/api/terminals', (req, res) => {
  const terminalList = Object.values(TERMINAL_REGISTRY).map(t => ({
    id: t.id,
    name: t.name,
    poiid: t.poiid,
    taps: t.taps
  }));
  res.json({ success: true, terminals: terminalList });
});

// Dynamic Card Acquisition Trigger
app.post('/api/start-tap', async (req, res) => {
  const { terminalId } = req.body;
  const terminal = TERMINAL_REGISTRY[terminalId];

  if (!terminal) {
    return res.status(400).json({ 
      success: false, 
      error: `Invalid terminal selected: "${terminalId}".` 
    });
  }

  const serviceId = generateServiceID();
  const timestamp = new Date().toISOString();
  const transactionId = 'TX' + String(Date.now()).slice(-6);

  // Short SaleID: strictly under 16 characters (e.g. "POS_BOOTH1")
  const shortSaleId = `POS_${terminal.id.replace('-', '').toUpperCase()}`.slice(0, 16);

  // Simulation mode check
  if (SIMULATION_MODE) {
    console.log(`\n[SIMULATION MODE] Simulating tap on ${terminal.name} (${terminal.poiid})...`);
    await new Promise(r => setTimeout(r, 1200));

    charityState.totalAmountUSD += DONATION_AMOUNT;
    charityState.totalUSD = charityState.totalAmountUSD;
    charityState.totalDonors += 1;
    TERMINAL_REGISTRY[terminalId].taps += 1;

    const eventData = {
      id: Date.now(),
      amountUSD: DONATION_AMOUNT,
      terminal: terminal.name,
      poiid: terminal.poiid,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    charityState.recentDonations.unshift(eventData);
    if (charityState.recentDonations.length > 20) charityState.recentDonations.pop();

    io.emit('donation_received', { state: charityState, latest: eventData });
    io.emit('tap_success', { state: charityState, latest: eventData });

    return res.json({ 
      success: true, 
      simulated: true,
      terminal: terminal.name, 
      poiid: terminal.poiid,
      totalUSD: charityState.totalAmountUSD, 
      addedUSD: DONATION_AMOUNT 
    });
  }

  // Live Cloud Terminal API Payload
  const adyenPayload = {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: "3.0",
        MessageClass: "Service",
        MessageCategory: "CardAcquisition",
        MessageType: "Request",
        ServiceID: serviceId,
        SaleID: shortSaleId,
        POIID: terminal.poiid
      },
      CardAcquisitionRequest: {
        SaleData: {
          SaleTransactionID: {
            TransactionID: transactionId,
            TimeStamp: timestamp
          },
          // Base64 for {"Operation":[{"Type":"NFCReadUID"}]}
          SaleToPOIData: "ewogICAgIk9wZXJhdGlvbiI6WwogICAgICAgIHsKICAgICAgICAgICAgIlR5cGUiOiJORkNSZWFkVUlEIgogICAgICAgIH0KICAgIF0KfQ=="
        },
        CardAcquisitionTransaction: {
          TotalAmount: DONATION_AMOUNT
        }
      }
    }
  };

  console.log(`\n------------------------------------------------------------`);
  console.log(`📡 [DISPATCH] Sending CardAcquisition to terminal ${terminal.poiid} (${terminal.name})`);
  console.log(`📦 Payload: ServiceID=${serviceId}, SaleID=${shortSaleId}, POIID=${terminal.poiid}`);

  try {
    const adyenResponse = await fetch(ADYEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-API-key': ADYEN_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(adyenPayload)
    });

    const responseStatus = adyenResponse.status;
    const json = await adyenResponse.json();

    console.log(`📥 [RESPONSE] HTTP Status ${responseStatus} from Adyen Cloud`);
    console.log(`📄 Response Body:\n`, JSON.stringify(json, null, 2));

    if (!adyenResponse.ok) {
      return res.status(responseStatus).json({ 
        success: false, 
        error: 'Terminal API cloud error', 
        details: json 
      });
    }

    const cardAcqResp = json?.SaleToPOIResponse?.CardAcquisitionResponse;
    const resultStatus = cardAcqResp?.Response?.Result;

    if (resultStatus === 'Success') {
      console.log(`✅ [SUCCESS] Card / Badge successfully read on ${terminal.poiid}!`);

      // Update state for Stage Dashboard & Mobile POS
      charityState.totalAmountUSD += DONATION_AMOUNT;
      charityState.totalUSD = charityState.totalAmountUSD;
      charityState.totalDonors += 1;
      TERMINAL_REGISTRY[terminalId].taps += 1;

      const eventData = {
        id: Date.now(),
        amountUSD: DONATION_AMOUNT,
        terminal: terminal.name,
        poiid: terminal.poiid,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };

      charityState.recentDonations.unshift(eventData);
      if (charityState.recentDonations.length > 20) charityState.recentDonations.pop();

      // Emit to both dashboard and mobile POS
      io.emit('donation_received', { state: charityState, latest: eventData });
      io.emit('tap_success', { state: charityState, latest: eventData });

      // Send the EnableService abort request to display the custom thank you screen
      sendEnableServiceAbort(terminal.poiid, shortSaleId).catch(err => {
        console.error('Non-blocking abort error:', err);
      });

      return res.json({ 
        success: true, 
        terminal: terminal.name,
        poiid: terminal.poiid,
        totalUSD: charityState.totalAmountUSD, 
        addedUSD: DONATION_AMOUNT 
      });
    } else {
      const errorCondition = cardAcqResp?.Response?.ErrorCondition || 'Declined / Cancelled';
      console.warn(`⚠️ [NOT SUCCESS] Result: ${resultStatus}, Condition: ${errorCondition}`);
      return res.status(400).json({ 
        success: false, 
        error: `Terminal tap not completed (${errorCondition})`, 
        details: json 
      });
    }
  } catch (networkErr) {
    console.error(`💥 Network exception connecting to Adyen:`, networkErr.message);
    return res.status(500).json({ 
      success: false, 
      error: 'Network failure communicating with Adyen Terminal API', 
      message: networkErr.message 
    });
  }
});

// Presenter Stage Dashboard Simulation & Admin Endpoints
app.post('/api/simulate', (req, res) => {
  const amount = parseInt(req.body.amount || '10', 10);
  charityState.totalAmountUSD += amount;
  charityState.totalUSD = charityState.totalAmountUSD;
  charityState.totalDonors += 1;

  const eventData = {
    id: Date.now(),
    amountUSD: amount,
    terminal: 'Stage Demonstration',
    poiid: 'DEMO',
    timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  charityState.recentDonations.unshift(eventData);
  if (charityState.recentDonations.length > 20) charityState.recentDonations.pop();

  io.emit('donation_received', { state: charityState, latest: eventData });
  res.json({ success: true, state: charityState });
});

app.post('/api/jump-milestone', (req, res) => {
  const nextMilestone = (Math.floor(charityState.totalAmountUSD / 2500) + 1) * 2500;
  const diff = nextMilestone - charityState.totalAmountUSD;
  charityState.totalAmountUSD = nextMilestone;
  charityState.totalUSD = nextMilestone;
  charityState.totalDonors += 1;

  const eventData = {
    id: Date.now(),
    amountUSD: diff,
    terminal: 'Milestone Catalyst',
    poiid: 'CATALYST',
    timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  charityState.recentDonations.unshift(eventData);
  io.emit('donation_received', { state: charityState, latest: eventData });
  res.json({ success: true, state: charityState });
});

app.post('/api/reset', (req, res) => {
  charityState.totalAmountUSD = 0;
  charityState.totalUSD = 0;
  charityState.totalDonors = 0;
  charityState.recentDonations = [];
  Object.keys(TERMINAL_REGISTRY).forEach(k => TERMINAL_REGISTRY[k].taps = 0);
  io.emit('donation_received', { state: charityState });
  io.emit('state_reset', charityState);
  res.json({ success: true });
});

app.get('/api/state', (req, res) => res.json(charityState));

// WebSocket Connection Handshake
io.on('connection', (socket) => {
  socket.emit('initial_state', charityState);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Charity POS Server listening on http://localhost:${PORT}`);
  console.log(`📱 Attendee Universal POS:  http://localhost:${PORT}/pos.html`);
  console.log(`🖥️  Stage Dashboard:         http://localhost:${PORT}/stage.html`);
  console.log(`🎯 Presenter Admin Mode:     http://localhost:${PORT}/stage.html?admin=adyen2026`);
  console.log(`🔧 Mode: ${SIMULATION_MODE ? 'SIMULATION (Mock Taps)' : '🔴 LIVE ADYEN TERMINAL API'}`);
  console.log(`==================================================\n`);
});
