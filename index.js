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

  // For Person column, we extract an email from "REMIT ALL INVOICES TO:" but we'll actually override it.
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
    // Instead of passing the file path to the file column, we handle file uploads separately.
    woFile: process.env.PDF_PATH || "N/A"
  };
}

/**
 * Retrieves your own user ID from Monday.com using the "me" query.
 */
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

/**
 * Creates a new item on Monday.com.
 * Note: For file columns, it's best to leave them empty and then upload the file separately.
 */
async function addTaskToMonday(taskDetails) {
  // Build column values; assign an empty string for the file column.
  const columnValues = {
    "name": `Work Order ${taskDetails.workOrder}`,
    "person": { 
      "personsAndTeams": [{ "id": taskDetails.pmId, "kind": "person" }] 
    },
    "numeric_mknm7fe6": Number(taskDetails.workOrder) || 0,
    "numeric_mknmh57z": Number(taskDetails.purchaseOrder) || 0,
    "text_mknmenkj": taskDetails.state,
    "file_mknmzjw8": "",  // Leave file column blank
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

  // Get your user ID via the me query.
  const myUserId = await getMyUserId();
  if (!myUserId) {
    return res.status(500).json({ message: "Failed to fetch your user ID from Monday.com" });
  }
  console.log("My user ID is:", myUserId);

  // Override the person data: assign every item to your user ID.
  taskDetails.pmId = myUserId;

  // Create the item on Monday.com.
  const result = await addTaskToMonday(taskDetails);
  if (!result) {
    return res.status(500).json({ message: "Failed to add task to Monday.com" });
  }

  res.json({ message: "Task successfully added to Monday.com", result });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
