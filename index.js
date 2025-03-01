require('dotenv').config();
const express = require('express');
const fs = require('fs');
const pdf = require('pdf-parse');
const axios = require('axios');
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

function extractFields(text) {
    const lines = text.split("\n").map(line => line.trim());
    
    let workOrder = "N/A", purchaseOrder = "N/A", state = "N/A", pm = "N/A", notes = "N/A";
    let itemDescription = "N/A", unitCost = "N/A", quantity = "N/A", totalCost = "N/A";
    let shippingTerms = "N/A", paymentTerms = "N/A", orderedBy = "N/A";

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes("work order")) {
            workOrder = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("purchase order")) {
            purchaseOrder = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("state")) {
            state = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("ordered by")) {
            orderedBy = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("remarks")) {
            notes = lines[i + 1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("nte:")) {
            itemDescription = lines[i];
            unitCost = lines[i + 1].split(" ")[0]?.trim() || "N/A";
            quantity = lines[i + 1].split(" ")[1]?.trim() || "N/A";
            totalCost = lines[i + 1].split(" ")[2]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("shipping terms")) {
            shippingTerms = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("payment terms")) {
            paymentTerms = lines[i].split(":")[1]?.trim() || "N/A";
        }
    }

    return {
        workOrder,
        purchaseOrder,
        state,
        pm,
        orderedBy,
        notes,
        itemDescription,
        unitCost,
        quantity,
        totalCost,
        shippingTerms,
        paymentTerms
    };
}


async function addTaskToMonday(taskDetails) {
    const columnValues = {
        "name": `Work Order ${taskDetails.workOrder}`,
        "person": taskDetails.pm !== "N/A" ? { "personsAndTeams": [{ "id": taskDetails.pm, "kind": "person" }] } : {},
        "numeric_mknm7fe6": Number(taskDetails.workOrder) || 0,
        "numeric_mknmh57z": Number(taskDetails.purchaseOrder) || 0,
        "text_mknmenkj": taskDetails.state,
        "file_mknmzjw8": taskDetails.woFile,
        "long_text_mknmgpk": taskDetails.notes
    };

    console.log("Column Values:", columnValues); // Log the column values

    try {
        const response = await monday.api(`
        mutation {
            create_item (
                board_id: ${process.env.MONDAY_BOARD_ID},
                item_name: "Work Order ${taskDetails.workOrder}",
                column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}"
            ) {
                id
            }
        }`);
        console.log("Task added:", response);
        return response;
    } catch (error) {
        console.error("Error adding task to Monday.com:", error.response ? error.response.data : error);
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
    const result = await addTaskToMonday(taskDetails);
    
    if (!result) {
        return res.status(500).json({ message: "Failed to add task to Monday.com" });
    }

    res.json({ message: "Task successfully added to Monday.com", result });
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
