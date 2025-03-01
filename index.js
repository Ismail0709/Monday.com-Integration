require('dotenv').config();
const express = require('express');
const fs = require('fs');
const pdf = require('pdf-parse');
const mondaySdk = require('monday-sdk-js');
const app = express();

const monday = mondaySdk();
monday.setToken(process.env.MONDAY_API_KEY);

async function extractPdfData() {
  try {
    const readData = fs.readFileSync(process.env.PDF_PATH);
    const data = await pdf(readData);
    return data.text;
  } catch (err) {
    console.error("Error extracting data from PDF file:", err);
    return null;
  }
}

async function fetchUsers() {
  try {
    const response = await monday.api(`
      query {
        users {
          id
          email
        }
      }`);
    return response.data.users;
  } catch (error) {
    console.error("Error fetching users:", error);
    return [];
  }
}

function extractFields(text) {
  const lines = text.split("\n").map(line => line.trim());

  let workOrder = "N/A",
      purchaseOrder = "N/A",
      state = "N/A",
      notes = "N/A",
      itemDescription = "N/A",
      unitCost = "N/A",
      quantity = "N/A",
      totalCost = "N/A",
      shippingTerms = "N/A",
      paymentTerms = "N/A";

  let pmEmail = "N/A";
  let pmName = "N/A"; 

  const isEmail = (str) => /\S+@\S+\.\S+/.test(str);

  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();

    // Work Order extraction
    if (lowerLine.includes("work order")) {
      const match = lines[i].match(/work order[:\s]*(\d+)/i);
      if (match) {
        workOrder = match[1];
      }
    } else if (lowerLine.startsWith("purchase order")) {
      const match = lines[i].match(/purchase order[:\s]*(\d+)/i);
      if (match) {
        purchaseOrder = match[1];
      }
    } else if (lowerLine.includes("p.o.")) {
      if (!lowerLine.includes("date")) {
        const match = lines[i].match(/p\.o\.[:#\s]*(\d+)/i);
        if (match) {
          purchaseOrder = match[1];
        }
      }
    } else if (lowerLine.startsWith("state")) {
      const match = lines[i].match(/state[:\s]*(\w+)/i);
      if (match) {
        state = match[1];
      }
    } else if (lowerLine.includes("remit all invoices to")) {
      let j = i + 1;
      while (j < lines.length && lines[j] === "") { j++; }
      if (j < lines.length && isEmail(lines[j])) {
        pmEmail = lines[j];
      }
    } else if (lowerLine.includes("shipping terms")) {
      const match = lines[i].match(/shipping terms[:\s]*(.*)/i);
      if (match) {
        shippingTerms = match[1];
      }
    } else if (lowerLine.includes("payment terms")) {
      const match = lines[i].match(/payment terms[:\s]*(.*)/i);
      if (match) {
        paymentTerms = match[1];
      }
    } else if (lowerLine.includes("nte:")) {
      itemDescription = lines[i];
      if (i + 1 < lines.length) {
        const parts = lines[i + 1].split(" ");
        unitCost = parts[0] ? parts[0].trim() : "N/A";
        quantity = parts[1] ? parts[1].trim() : "N/A";
        totalCost = parts[2] ? parts[2].trim() : "N/A";
      }
    }
  }

  if (state === "N/A") {
    for (let line of lines) {
      const match = line.match(/,\s*([A-Z]{2})\b/);
      if (match) {
        state = match[1];
        break;
      }
    }
  }

  const lowerText = text.toLowerCase();
  if (lowerText.includes("instructions:")) {
    const instructionsStart = lowerText.indexOf("instructions:") + "instructions:".length;
    notes = text.substring(instructionsStart).trim();
  }

  return {
    workOrder,
    purchaseOrder,
    state,
    pm: { name: pmName, email: pmEmail },
    notes,
    itemDescription,
    unitCost,
    quantity,
    totalCost,
    shippingTerms,
    paymentTerms,
    woFile: process.env.PDF_PATH || "N/A"
  };
}

async function getMyUserId() {
  try {
    const meResponse = await monday.api(`
      query {
        me {
          id
          name
          email
        }
      }
    `);
    return meResponse.data.me.id;
  } catch (error) {
    console.error("Error fetching my user ID:", error);
    return null;
  }
}

async function addTaskToMonday(taskDetails) {

  const columnValues = {
    "name": `Work Order ${taskDetails.workOrder}`,
    "person": { 
      "personsAndTeams": [{ "id": taskDetails.pmId, "kind": "person" }] 
    },
    "numeric_mknm7fe6": Number(taskDetails.workOrder) || 0,
    "numeric_mknmh57z": Number(taskDetails.purchaseOrder) || 0,
    "text_mknmenkj": taskDetails.state,
    "file_mknmzjw8": "", 
    "long_text_mknmgpk": taskDetails.notes
  };

  console.log("Column Values:", columnValues);

  const queryCreate = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
      }
    }`;

  try {
    const createResponse = await monday.api(queryCreate, {
      variables: {
        boardId: process.env.MONDAY_BOARD_ID,
        itemName: `Work Order ${taskDetails.workOrder}`,
        columnValues: JSON.stringify(columnValues)
      }
    });
    console.log("Item created:", createResponse);
    return createResponse;
  } catch (error) {
    console.error("Error creating item:", error.response ? error.response.data : error);
    return null;
  }
}

app.get('/run-task', async (req, res) => {
  console.log("Processing PDF and sending data to Monday.com...");

  const extractedText = await extractPdfData();
  if (!extractedText) {
    return res.status(500).json({ message: "Failed to extract data from PDF" });
  }

  const taskDetails = extractFields(extractedText);

  const myUserId = await getMyUserId();
  if (!myUserId) {
    return res.status(500).json({ message: "Failed to fetch your user ID from Monday.com" });
  }
  console.log("My user ID is:", myUserId);

  
  taskDetails.pmId = myUserId;

  
  const result = await addTaskToMonday(taskDetails);
  if (!result) {
    return res.status(500).json({ message: "Failed to add task to Monday.com" });
  }

  res.json({ message: "Task successfully added to Monday.com", result });
});

async function extractEmailPdfData() {
    try {
      const readData = fs.readFileSync(process.env.EMAIL_PDF_PATH);
      const data = await pdf(readData);
      return data.text;
    } catch (err) {
      console.error("Error extracting data from PDF file:", err);
      return null;
    }
  }

  function parseEmailContent(emailText) {
    let workOrder = "N/A";
    let purchaseOrder = "N/A";
    let scheduledDate = "N/A";
    let location = "N/A";
    let checkInPhone = "N/A";
    let flatRatePrice = "N/A";
    let notes = emailText; // default entire email text as notes
    let instructions = "N/A"; // initialize instructions
    let state = "N/A";
  
    // Extract Work Order: matches "WO" followed by digits
    const woMatch = emailText.match(/WO\s*(\d+)/i);
    if (woMatch) {
      workOrder = woMatch[1];
    }
  
    // Extract Purchase Order: matches "PO" followed by digits
    const poMatch = emailText.match(/PO\s*(\d+)/i);
    if (poMatch) {
      purchaseOrder = poMatch[1];
    }
  
    // Extract scheduled date: expects a pattern like "scheduled date of 12/5/2023"
    const dateMatch = emailText.match(/scheduled date of\s*([\d\/]+)/i);
    if (dateMatch) {
      scheduledDate = dateMatch[1];
    }
  
    // Extract check-in phone number: looks for "CALLING" followed by digits and dashes
    const phoneMatch = emailText.match(/CALLING\s*([\d\-]+)/i);
    if (phoneMatch) {
      checkInPhone = phoneMatch[1];
    }
  
    // Extract flat rate price: looks for "FLAT RATE price" followed by a dollar sign and number
    const priceMatch = emailText.match(/FLAT RATE price.*?\$(\d+(?:\.\d+)?)/i);
    if (priceMatch) {
      flatRatePrice = priceMatch[1];
    }
  
    // Extract location: an example method that captures text after "WO/PO" up to the next comma.
    const locMatch = emailText.match(/WO\/PO\s+([^,]+),/i);
    if (locMatch) {
      location = locMatch[1].trim();
    }
  
    // Extract state from location (e.g., "Brunswick, GA 31520")
    const stateMatch = location.match(/,\s*([A-Z]{2})\b/);
    if (stateMatch) {
      state = stateMatch[1];
    }
  
    // Extract notes and instructions: split based on "Deliverables"
    const deliverablesMatch = emailText.split(/Deliverables/i);
    if (deliverablesMatch.length > 1) {
      notes = deliverablesMatch[0].trim();
      instructions = deliverablesMatch[1].trim();
    } else {
      notes = emailText.trim(); // fallback if "Deliverables" not found
    }
  
    return {
      workOrder,
      purchaseOrder,
      scheduledDate,
      location,
      checkInPhone,
      flatRatePrice,
      notes,
      instructions,
      state
  };
}
  
  app.get('/run-email-task', async (req, res) => {
    console.log("Processing email (from PDF) and extracting data...");
  
    const extractedText = await extractEmailPdfData();
    if (!extractedText) {
      return res.status(500).json({ message: "Failed to extract data from PDF" });
    }
  
    const parsedData = parseEmailContent(extractedText);
    console.log("Parsed Email Data:", parsedData);
  
    // Get your user ID via the me query.
    const myUserId = await getMyUserId();
    if (!myUserId) {
      return res.status(500).json({ message: "Failed to fetch your user ID from Monday.com" });
    }
    console.log("My user ID is:", myUserId);
  
    // Build task details with parsed data and your user ID
    const taskDetails = {
      workOrder: parsedData.workOrder,
      purchaseOrder: parsedData.purchaseOrder,
      state: parsedData.state, // extracted from the location
      notes: parsedData.notes,
      scheduledDate: parsedData.scheduledDate,
      location: parsedData.location,
      checkInPhone: parsedData.checkInPhone,
      flatRatePrice: parsedData.flatRatePrice,
      instructions: parsedData.instructions,
      pmId: myUserId // Use your actual user ID
    };
  
    const result = await addTaskToMonday(taskDetails);
    if (!result) {
      return res.status(500).json({ message: "Failed to add task to Monday.com" });
    }
  
    res.json({ message: "Task successfully added to Monday.com", result });
  });

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
