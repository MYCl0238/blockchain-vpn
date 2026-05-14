import { customAlphabet, nanoid } from "nanoid";

//* 16 haneli id üretir döner
export function generateID() {
  const nanoid = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 16);
  //! hashlama yapacaksın
  const userId = nanoid();
  return userId;
}

export async function generateUser(db, mail) {
  let id, result;
  do {
    id = generateID();
    result = await getUser(db, id);
  } while (result !== undefined);

  const query = `INSERT INTO users (id, recovery_email) VALUES ($1, $2) RETURNING *;`;
  const values = [id, mail];
  const user = await db.query(query, values);

  console.log(user.rows[0]);
  return user.rows[0];
}

export async function getUser(db, id) {
  const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

export async function updateUserEmail(db, id, mail) {
  const query = `
    UPDATE users
    SET recovery_email = $1
    WHERE id = $2
    RETURNING *;
  `;
  const result = await db.query(query, [mail, id]);
  return result.rows[0];
}

/*
export async function s(db, id) {
  const user = await getUser(db, id);
  const device = await DeviceControl(db, id);

  const devices = await db.query(
    "SELECT * FROM devices WHERE user_id = $1;",
    id,
  );
  if (devices) {
    await db.query("UPDATE devices SET last_actice = $1 WHERE user_id = $2", [
      Date.now(),
      id,
    ]);
  } else {
    await db.query(
      "INSERT INTO devices (user_id,device_type,device_token,last_active) VALUES ($1,$2,$3,$4)",
      [id],
    );
  }
}
  */

/*
^generate user
if db has this id, generate new id
sql injection riski için bu şekilde yapmak daha iyi
eleman oluşturup db'ye ekleme kısmı
oluşturulan user bilgilerini return ettik


*/
