import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(cors({
  origin: allowedOrigin,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    error: "Trop de demandes. Réessayez plus tard."
  }
});

app.use("/send-whatsapp", limiter);

const canUseTwilio =
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_WHATSAPP_FROM;

const client = canUseTwilio
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    app: "Dakar AutoPièces API"
  });
});

app.post("/send-whatsapp", async (req, res) => {
  try {
    const {
      name,
      phone,
      brand,
      model,
      year,
      category,
      part,
      description,
      imageUrl
    } = req.body;

    if (!name || !phone || !brand || !model || !year || !part) {
      return res.status(400).json({
        error: "Champs obligatoires manquants."
      });
    }

    if (!canUseTwilio) {
      console.warn("Twilio non configuré. Message non envoyé.");
      return res.json({
        success: true,
        warning: "Twilio non configuré."
      });
    }

    const adminMessage = `
Nouvelle demande Dakar AutoPièces

Client: ${name}
WhatsApp: ${phone}

Véhicule: ${brand} ${model} ${year}
Catégorie: ${category || "Non précisée"}
Pièce: ${part}

Détails:
${description || "Aucun détail"}

Photo:
${imageUrl || "Aucune photo"}
`;

    const clientMessage = `
Bonjour ${name},

Votre demande a bien été reçue.

Véhicule: ${brand} ${model} ${year}
Pièce demandée: ${part}

Nous allons vous contacter bientôt avec les disponibilités et le devis.

Dakar AutoPièces
`;

    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to: `whatsapp:${phone}`,
      body: clientMessage
    });

    if (process.env.ADMIN_WHATSAPP) {
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
        to: `whatsapp:${process.env.ADMIN_WHATSAPP}`,
        body: adminMessage
      });
    }

    res.json({
      success: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur pendant l’envoi WhatsApp."
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
