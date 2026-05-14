import pg from "pg";
import dotenv from "dotenv";

// .env dosyasını okuması için başlatıyoruz
dotenv.config();

// pg paketinden Pool sınıfını alıyoruz
const { Pool } = pg;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Bağlantıyı test edelim
pool
  .query("SELECT 1")
  .then(() => console.log("PostgreSQL bağlantısı kusursuz sağlandı! 🚀"))
  .catch((err) => console.error("Veritabanına bağlanılamadı!", err.stack));

// pool objesini dışarı aktarıyoruz
export default pool;
