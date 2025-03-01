require('dotenv').config();
const express = require('express');
const fs = require('fs');
const pdf = require('pdf-parse');
const axios = require('axios');
const app = express();

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

    let workOrder = "N/A", purchaseOrder = "N/A", scheduledDate = "N/A", location = "N/A";
    let checkInPhone = "N/A", ivrBackupPhone = "N/A", flatRatePrice = "N/A", notes = "N/A";
    let project = "N/A", pm = "N/A", state = "N/A", woFile = "N/A"; 

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes("work order")) {
            workOrder = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("purchase order")) {
            purchaseOrder = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("scheduled date")) {
            scheduledDate = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("location")) {
            location = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("check-in via store phone")) {
            checkInPhone = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("ivr backup check-in")) {
            ivrBackupPhone = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("flat rate price")) {
            flatRatePrice = lines[i].split("$")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("ordered by")) {
            pm = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("state")) {
            state = lines[i].split(":")[1]?.trim() || "N/A";
        } else if (lines[i].toLowerCase().includes("remarks")) {
            notes = lines[i + 1]?.trim() || "N/A";  // Assuming remarks contain notes in the next line
        }
    }

    return {
        project: "Project Name", // You might need to set this dynamically
        pm,
        workOrder,
        purchaseOrder,
        state,
        woFile: "N/A",
        notes,
        location,
        checkInPhone,
        ivrBackupPhone,
        flatRatePrice
    };
}

async function addTaskToMonday(taskDetails) {
    const columnValues = JSON.stringify({
        text_column: `WO: ${taskDetails.workOrder} | PO: ${taskDetails.purchaseOrder}`,
        date_column: { date: taskDetails.scheduledDate },
        location_column: taskDetails.location,
        phone_column: taskDetails.checkInPhone,
        backup_phone_column: taskDetails.ivrBackupPhone,
        price_column: taskDetails.flatRatePrice,
        project_column: taskDetails.project,
        pm_column: taskDetails.pm,
        wo_number_column: taskDetails.workOrder,
        po_number_column: taskDetails.purchaseOrder,
        state_column: taskDetails.state,
        wo_file_column: taskDetails.woFile,
        notes_column: taskDetails.notes
    });

    const query = `
    mutation {
        create_item (
            board_id: "${process.env.MONDAY_BOARD_ID}", 
            item_name: "Work Order ${taskDetails.workOrder}", 
            column_values: ${JSON.stringify(columnValues)}
        ) {
            id
        }
    }
    `;

    try {
        const response = await axios.post(
            "https://api.monday.com/v2",
            { query },
            { headers: { "Authorization": process.env.MONDAY_API_KEY, "Content-Type": "application/json" } }
        );
        console.log("Task added:", response.data);
        return response.data;
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

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});
