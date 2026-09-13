/**
 * How Nigerian names, places and everyday words are said, for the voice that says them.
 *
 * A voice model trained mostly on American and British speech reads "Ikeja" as "eye-KEE-ja"
 * and "Sikiru" as "SICK-ih-roo", and a caller who hears their own name or their own street
 * mangled stops trusting everything after it. The language model never sees this table and
 * must not: it decides *which* words are said, and this decides how they *sound*, one step
 * before the voice.
 *
 * Two forms per entry, because voices differ in what they accept. `sayAs` is a respelling
 * in plain syllables — "ee-kay-jah" — which every voice reads and most read well. `ipa` is
 * the International Phonetic Alphabet, exact, for the voices that take a `<phoneme>` tag
 * (ElevenLabs Flash v2, Turbo v2 and English v1; not v2.5 or the multilingual models).
 * `applyPronunciations` uses whichever the voice in front of it can take.
 *
 * The built-in list is a Nigerian floor, not a ceiling. It is the words nearly every
 * Nigerian business will say — the states and their capitals, the districts of Lagos, Abuja
 * and Port Harcourt, the common Yoruba, Igbo, Hausa, Edo, Urhobo, Efik and Tiv names, the
 * everyday words and the household institutions. It carries no business's own vocabulary;
 * an organisation adds its own entries, and an entry it adds for a term already here wins.
 * Ordinary English words are deliberately absent: a voice already says "Delta", "Plateau"
 * and "Rivers", and respelling them would only make them worse.
 *
 * The transcriptions are broad, in the phonemes an English voice model can produce. Yoruba
 * and Igbo tone, the labial-velar stops of "gb" and "kp", and vowel nasalisation are all
 * approximated, because no English voice has them; the aim is a name its owner recognises,
 * not a phonetician's record.
 */

export interface Pronunciation {
  /** The word or phrase as it is written. Matched whole, case-insensitively. */
  readonly term: string;
  /** How to say it, respelled in plain syllables a voice reads as English. */
  readonly sayAs: string;
  /** How to say it, in IPA, for a voice that takes phoneme tags. Optional. */
  readonly ipa?: string;
}

/** Which form of pronunciation a voice can take. Respelling is the one every voice reads. */
export type PronunciationMode = "respelling" | "phoneme-tags";

const entry = (term: string, sayAs: string, ipa?: string): Pronunciation =>
  ipa === undefined ? { term, sayAs } : { term, sayAs, ipa };

/** The thirty-six states and the capital, and their capitals. */
const STATES_AND_CAPITALS: readonly Pronunciation[] = [
  entry("Abia", "ah-bee-ah", "aˈbia"),
  entry("Umuahia", "oo-moo-ah-hee-ah", "umuˈahia"),
  entry("Adamawa", "ah-dah-mah-wah", "adaˈmawa"),
  entry("Yola", "yoh-lah", "ˈjola"),
  entry("Akwa Ibom", "ak-wah ee-bom", "ˈakwa iˈbɔm"),
  entry("Uyo", "oo-yoh", "ˈujo"),
  entry("Anambra", "ah-nam-brah", "aˈnambra"),
  entry("Awka", "ok-kah", "ˈɔka"),
  entry("Bauchi", "bow-chee", "ˈbautʃi"),
  entry("Bayelsa", "bah-yel-sah", "baˈjɛlsa"),
  entry("Yenagoa", "yeh-nah-goh-ah", "jenaˈɡoa"),
  entry("Benue", "beh-noo-eh", "ˈbenue"),
  entry("Makurdi", "mah-koor-dee", "maˈkurdi"),
  entry("Borno", "bor-noh", "ˈbɔrno"),
  entry("Maiduguri", "my-doo-goo-ree", "maiduˈɡuri"),
  entry("Cross River", "cross river"),
  entry("Calabar", "kah-lah-bar", "ˈkalabar"),
  entry("Asaba", "ah-sah-bah", "aˈsaba"),
  entry("Ebonyi", "eh-boh-nyee", "eˈboɲi"),
  entry("Abakaliki", "ah-bah-kah-lee-kee", "abakaˈliki"),
  entry("Edo", "eh-doh", "ˈedo"),
  entry("Benin", "beh-neen", "bɛˈnin"),
  entry("Benin City", "beh-neen city", "bɛˈnin ˈsɪti"),
  entry("Ekiti", "eh-kee-tee", "eˈkiti"),
  entry("Ado Ekiti", "ah-doh eh-kee-tee", "ˈado eˈkiti"),
  entry("Enugu", "eh-noo-goo", "eˈnuɡu"),
  entry("Gombe", "gom-beh", "ˈɡombe"),
  entry("Imo", "ee-moh", "ˈimo"),
  entry("Owerri", "oh-weh-ree", "oˈwɛri"),
  entry("Jigawa", "jee-gah-wah", "dʒiˈɡawa"),
  entry("Dutse", "doot-seh", "ˈdutse"),
  entry("Kaduna", "kah-doo-nah", "kaˈduna"),
  entry("Kano", "kah-noh", "ˈkano"),
  entry("Katsina", "kat-see-nah", "ˈkatsina"),
  entry("Kebbi", "keb-bee", "ˈkɛbi"),
  entry("Birnin Kebbi", "bir-nin keb-bee", "ˈbirnin ˈkɛbi"),
  entry("Kogi", "koh-gee", "ˈkoɡi"),
  entry("Lokoja", "loh-koh-jah", "loˈkodʒa"),
  entry("Kwara", "kwah-rah", "ˈkwara"),
  entry("Ilorin", "ee-loh-rin", "iˈlɔrin"),
  entry("Lagos", "lay-goss", "ˈleɡɔs"),
  entry("Ikeja", "ee-kay-jah", "iˈkedʒa"),
  entry("Nasarawa", "nah-sah-rah-wah", "nasaˈrawa"),
  entry("Lafia", "lah-fee-ah", "laˈfia"),
  entry("Minna", "min-nah", "ˈmina"),
  entry("Ogun", "oh-goon", "oˈɡun"),
  entry("Abeokuta", "ah-beh-oh-koo-tah", "abeˈokuta"),
  entry("Ondo", "on-doh", "ˈondo"),
  entry("Akure", "ah-koo-reh", "aˈkure"),
  entry("Osun", "oh-shoon", "oˈʃun"),
  entry("Osogbo", "oh-shog-boh", "oˈʃoɡbo"),
  entry("Oshogbo", "oh-shog-boh", "oˈʃoɡbo"),
  entry("Oyo", "oh-yoh", "ˈojo"),
  entry("Ibadan", "ee-bah-dan", "iˈbadan"),
  entry("Jos", "joss", "dʒɔs"),
  entry("Port Harcourt", "port har-court", "ˌpɔːt ˈhɑːkət"),
  entry("Sokoto", "soh-koh-toh", "ˈsokoto"),
  entry("Taraba", "tah-rah-bah", "taˈraba"),
  entry("Jalingo", "jah-lin-goh", "dʒaˈlinɡo"),
  entry("Yobe", "yoh-beh", "ˈjobe"),
  entry("Damaturu", "dah-mah-too-roo", "damaˈturu"),
  entry("Zamfara", "zam-fah-rah", "zamˈfara"),
  entry("Gusau", "goo-sow", "ɡuˈsau"),
  entry("Abuja", "ah-boo-jah", "aˈbudʒa"),
];

/** Lagos, district by district. */
const LAGOS: readonly Pronunciation[] = [
  entry("Agege", "ah-geh-geh", "aˈɡeɡe"),
  entry("Ajah", "ah-jah", "ˈadʒa"),
  entry("Alimosho", "ah-lee-moh-shoh", "alimoˈʃo"),
  entry("Amuwo Odofin", "ah-moo-woh oh-doh-fin", "aˈmuwo oˈdofin"),
  entry("Apapa", "ah-pah-pah", "aˈpapa"),
  entry("Badagry", "bah-dah-gree", "baˈdaɡri"),
  entry("Bariga", "bah-ree-gah", "baˈriɡa"),
  entry("Ebute Metta", "eh-boo-teh met-tah", "eˈbute ˈmɛta"),
  entry("Egbeda", "eg-beh-dah", "eɡˈbeda"),
  entry("Epe", "eh-peh", "ˈepe"),
  entry("Festac", "fes-tak", "ˈfɛstak"),
  entry("Gbagada", "gbah-gah-dah", "ɡbaˈɡada"),
  entry("Ibeju Lekki", "ee-beh-joo lek-kee", "iˈbedʒu ˈlɛki"),
  entry("Idumota", "ee-doo-moh-tah", "iduˈmota"),
  entry("Ikate", "ee-kah-teh", "iˈkate"),
  entry("Ikorodu", "ee-koh-roh-doo", "ikoˈrodu"),
  entry("Ikoyi", "ee-koy-ee", "iˈkoji"),
  entry("Ilupeju", "ee-loo-peh-joo", "iluˈpedʒu"),
  entry("Ipaja", "ee-pah-jah", "iˈpadʒa"),
  entry("Iyana Ipaja", "ee-yah-nah ee-pah-jah", "iˈjana iˈpadʒa"),
  entry("Isolo", "ee-soh-loh", "iˈsolo"),
  entry("Ketu", "keh-too", "ˈketu"),
  entry("Lekki", "lek-kee", "ˈlɛki"),
  entry("Magodo", "mah-goh-doh", "maˈɡodo"),
  entry("Mushin", "moo-shin", "ˈmuʃin"),
  entry("Obalende", "oh-bah-len-deh", "obaˈlɛnde"),
  entry("Ogba", "og-bah", "ˈoɡba"),
  entry("Ojo", "oh-joh", "ˈodʒo"),
  entry("Ojodu", "oh-joh-doo", "oˈdʒodu"),
  entry("Ojota", "oh-joh-tah", "oˈdʒota"),
  entry("Ojuelegba", "oh-joo-eh-leg-bah", "odʒueˈleɡba"),
  entry("Oshodi", "oh-shoh-dee", "oˈʃodi"),
  entry("Oyingbo", "oh-yin-boh", "oˈjinɡbo"),
  entry("Sangotedo", "san-goh-teh-doh", "sanɡoˈtedo"),
  entry("Somolu", "shoh-moh-loo", "ʃoˈmolu"),
  entry("Shomolu", "shoh-moh-loo", "ʃoˈmolu"),
  entry("Surulere", "soo-roo-leh-reh", "suruˈlere"),
  entry("Yaba", "yah-bah", "ˈjaba"),
  entry("Ajegunle", "ah-jeh-goon-leh", "adʒeˈɡunle"),
  entry("Ojokoro", "oh-joh-koh-roh", "odʒoˈkoro"),
  entry("Ogudu", "oh-goo-doo", "oˈɡudu"),
  entry("Oworonshoki", "oh-woh-ron-shoh-kee", "oworonˈʃoki"),
  entry("Ikotun", "ee-koh-toon", "iˈkotun"),
  entry("Igando", "ee-gan-doh", "iˈɡando"),
  entry("Abule Egba", "ah-boo-leh eg-bah", "aˈbule ˈeɡba"),
  entry("Sabo", "sah-boh", "ˈsabo"),
  entry("Akoka", "ah-koh-kah", "aˈkoka"),
  entry("Onikan", "oh-nee-kan", "oˈnikan"),
  entry("Marina", "mah-ree-nah", "maˈrina"),
  entry("Oniru", "oh-nee-roo", "oˈniru"),
  entry("Osapa", "oh-sah-pah", "oˈsapa"),
  entry("Agungi", "ah-goon-gee", "aˈɡunɡi"),
  entry("Chevron", "shev-ron", "ˈʃɛvrɔn"),
  entry("Ajah Badore", "ah-jah bah-doh-reh", "ˈadʒa baˈdore"),
  entry("Badore", "bah-doh-reh", "baˈdore"),
  entry("Awoyaya", "ah-woh-yah-yah", "awoˈjaja"),
  entry("Lakowe", "lah-koh-weh", "laˈkowe"),
];

/** Abuja and Port Harcourt, and the other towns a caller names. */
const TOWNS: readonly Pronunciation[] = [
  entry("Garki", "gar-kee", "ˈɡarki"),
  entry("Wuse", "woo-seh", "ˈwuse"),
  entry("Maitama", "my-tah-mah", "maiˈtama"),
  entry("Asokoro", "ah-soh-koh-roh", "asoˈkoro"),
  entry("Gwarinpa", "gwah-rin-pah", "ɡwaˈrinpa"),
  entry("Kubwa", "koob-wah", "ˈkubwa"),
  entry("Jabi", "jah-bee", "ˈdʒabi"),
  entry("Utako", "oo-tah-koh", "uˈtako"),
  entry("Lugbe", "loog-beh", "ˈluɡbe"),
  entry("Nyanya", "nyah-nyah", "ˈɲaɲa"),
  entry("Karu", "kah-roo", "ˈkaru"),
  entry("Gudu", "goo-doo", "ˈɡudu"),
  entry("Lokogoma", "loh-koh-goh-mah", "lokoˈɡoma"),
  entry("Kuje", "koo-jeh", "ˈkudʒe"),
  entry("Bwari", "bwah-ree", "ˈbwari"),
  entry("Galadimawa", "gah-lah-dee-mah-wah", "ɡaladiˈmawa"),
  entry("Durumi", "doo-roo-mee", "duˈrumi"),
  entry("Wuye", "woo-yeh", "ˈwuje"),
  entry("Katampe", "kah-tam-peh", "kaˈtampe"),
  entry("Dawaki", "dah-wah-kee", "daˈwaki"),
  entry("Mpape", "m-pah-peh", "ˈmpape"),
  entry("Gwagwalada", "gwag-wah-lah-dah", "ɡwaɡwaˈlada"),
  entry("Rumuola", "roo-moo-oh-lah", "rumuˈola"),
  entry("Rumuokoro", "roo-moo-oh-koh-roh", "rumuoˈkoro"),
  entry("Rumuigbo", "roo-moo-ig-boh", "rumuˈiɡbo"),
  entry("Trans Amadi", "trans ah-mah-dee", "trans aˈmadi"),
  entry("Obio Akpor", "oh-bee-oh ak-por", "oˈbio akˈpɔr"),
  entry("Diobu", "dee-oh-boo", "diˈobu"),
  entry("Eleme", "eh-leh-meh", "eˈleme"),
  entry("Choba", "choh-bah", "ˈtʃoba"),
  entry("Woji", "woh-jee", "ˈwodʒi"),
  entry("Aba", "ah-bah", "ˈaba"),
  entry("Nnewi", "n-nay-wee", "ˈnnewi"),
  entry("Nsukka", "n-sook-kah", "ˈnsuka"),
  entry("Ogbomosho", "og-boh-moh-shoh", "oɡboˈmoʃo"),
  entry("Ile-Ife", "ee-leh ee-feh", "iˈle iˈfe"),
  entry("Ife", "ee-feh", "iˈfe"),
  entry("Ijebu Ode", "ee-jeh-boo oh-deh", "iˈdʒebu ˈode"),
  entry("Ijebu", "ee-jeh-boo", "iˈdʒebu"),
  entry("Sagamu", "shah-gah-moo", "ʃaˈɡamu"),
  entry("Shagamu", "shah-gah-moo", "ʃaˈɡamu"),
  entry("Ota", "oh-tah", "ˈota"),
  entry("Sango Ota", "san-goh oh-tah", "ˈsanɡo ˈota"),
  entry("Mowe", "moh-weh", "ˈmowe"),
  entry("Ibafo", "ee-bah-foh", "iˈbafo"),
  entry("Warri", "wah-ree", "ˈwari"),
  entry("Sapele", "sah-peh-leh", "saˈpele"),
  entry("Ughelli", "oo-gel-lee", "uˈɡɛli"),
  entry("Effurun", "ef-foo-roon", "eˈfurun"),
  entry("Agbor", "ag-bor", "aɡˈbɔr"),
  entry("Auchi", "ow-chee", "ˈautʃi"),
  entry("Okene", "oh-keh-neh", "oˈkene"),
  entry("Offa", "off-fah", "ˈɔfa"),
  entry("Ogoja", "oh-goh-jah", "oˈɡodʒa"),
  entry("Ikot Ekpene", "ee-kot ek-peh-neh", "iˈkɔt ekˈpene"),
  entry("Eket", "eh-ket", "ˈekɛt"),
  entry("Oron", "oh-ron", "ˈorɔn"),
  entry("Otukpo", "oh-took-poh", "oˈtukpo"),
  entry("Gboko", "gboh-koh", "ˈɡboko"),
  entry("Wukari", "woo-kah-ree", "wuˈkari"),
  entry("Mubi", "moo-bee", "ˈmubi"),
  entry("Bida", "bee-dah", "ˈbida"),
  entry("Suleja", "soo-leh-jah", "suˈledʒa"),
  entry("Keffi", "kef-fee", "ˈkɛfi"),
  entry("Afikpo", "ah-fik-poh", "aˈfikpo"),
  entry("Orlu", "or-loo", "ˈɔrlu"),
  entry("Okigwe", "oh-kig-weh", "oˈkiɡwe"),
  entry("Onitsha", "oh-nee-chah", "oˈnitʃa"),
  entry("Zaria", "zah-ree-ah", "ˈzaria"),
  entry("Funtua", "foon-too-ah", "ˈfuntua"),
  entry("Azare", "ah-zah-reh", "aˈzare"),
  entry("Potiskum", "poh-tis-koom", "poˈtiskum"),
  entry("Nguru", "n-goo-roo", "ˈnɡuru"),
  entry("Bonny", "bon-nee", "ˈbɔni"),
  entry("Brass", "brass"),
  entry("Owo", "oh-woh", "ˈowo"),
  entry("Ikare", "ee-kah-reh", "iˈkare"),
  entry("Ondo Town", "on-doh town", "ˈondo taun"),
  entry("Oyo Town", "oh-yoh town", "ˈojo taun"),
  entry("Iwo", "ee-woh", "ˈiwo"),
  entry("Ede", "eh-deh", "ˈede"),
  entry("Ilesa", "ee-leh-shah", "iˈleʃa"),
  entry("Ilesha", "ee-leh-shah", "iˈleʃa"),
  entry("Ikire", "ee-kee-reh", "iˈkire"),
  entry("Ogbomoso", "og-boh-moh-shoh", "oɡboˈmoʃo"),
];

/** Yoruba names, given and family. */
const YORUBA_NAMES: readonly Pronunciation[] = [
  entry("Adebayo", "ah-deh-bah-yoh", "adeˈbajo"),
  entry("Adebola", "ah-deh-boh-lah", "adeˈbola"),
  entry("Adekunle", "ah-deh-koon-leh", "adeˈkunle"),
  entry("Adeola", "ah-deh-oh-lah", "adeˈola"),
  entry("Adeniyi", "ah-deh-nee-yee", "adeˈniji"),
  entry("Adesina", "ah-deh-shee-nah", "adeˈʃina"),
  entry("Adewale", "ah-deh-wah-leh", "adeˈwale"),
  entry("Adeyemi", "ah-deh-yeh-mee", "adeˈjemi"),
  entry("Adeyinka", "ah-deh-yin-kah", "adeˈjinka"),
  entry("Abiodun", "ah-bee-oh-doon", "abiˈodun"),
  entry("Abimbola", "ah-beem-boh-lah", "abimˈbola"),
  entry("Ade", "ah-deh", "ˈade"),
  entry("Akin", "ah-kin", "ˈakin"),
  entry("Akinwande", "ah-kin-wan-deh", "akinˈwande"),
  entry("Ayo", "ah-yoh", "ˈajo"),
  entry("Ayodele", "ah-yoh-deh-leh", "ajoˈdele"),
  entry("Ayomide", "ah-yoh-mee-deh", "ajoˈmide"),
  entry("Babatunde", "bah-bah-toon-deh", "babaˈtunde"),
  entry("Bisi", "bee-see", "ˈbisi"),
  entry("Bode", "boh-deh", "ˈbode"),
  entry("Bolanle", "boh-lan-leh", "boˈlanle"),
  entry("Bukola", "boo-koh-lah", "buˈkola"),
  entry("Damilola", "dah-mee-loh-lah", "damiˈlola"),
  entry("Dayo", "dah-yoh", "ˈdajo"),
  entry("Dele", "deh-leh", "ˈdele"),
  entry("Femi", "feh-mee", "ˈfemi"),
  entry("Folake", "foh-lah-keh", "foˈlake"),
  entry("Folasade", "foh-lah-shah-deh", "folaˈʃade"),
  entry("Funke", "foon-keh", "ˈfunke"),
  entry("Funmi", "foon-mee", "ˈfunmi"),
  entry("Funmilayo", "foon-mee-lah-yoh", "funmiˈlajo"),
  entry("Gbenga", "gben-gah", "ˈɡbɛŋɡa"),
  entry("Ibukun", "ee-boo-koon", "iˈbukun"),
  entry("Ifeoluwa", "ee-feh-oh-loo-wah", "ifeoˈluwa"),
  entry("Kehinde", "keh-hin-deh", "keˈhinde"),
  entry("Kolawole", "koh-lah-woh-leh", "kolaˈwole"),
  entry("Kunle", "koon-leh", "ˈkunle"),
  entry("Lanre", "lan-reh", "ˈlanre"),
  entry("Modupe", "moh-doo-peh", "moˈdupe"),
  entry("Morenike", "moh-reh-nee-keh", "moreˈnike"),
  entry("Niyi", "nee-yee", "ˈniji"),
  entry("Ola", "oh-lah", "ˈola"),
  entry("Olabisi", "oh-lah-bee-see", "olaˈbisi"),
  entry("Oladele", "oh-lah-deh-leh", "olaˈdele"),
  entry("Olamide", "oh-lah-mee-deh", "olaˈmide"),
  entry("Olaoluwa", "oh-lah-oh-loo-wah", "olaoˈluwa"),
  entry("Olumide", "oh-loo-mee-deh", "oluˈmide"),
  entry("Oluwafemi", "oh-loo-wah-feh-mee", "oluwaˈfemi"),
  entry("Oluwaseun", "oh-loo-wah-sheh-oon", "oluwaˈʃeun"),
  entry("Oluwatobi", "oh-loo-wah-toh-bee", "oluwaˈtobi"),
  entry("Oluwatosin", "oh-loo-wah-toh-sin", "oluwaˈtosin"),
  entry("Oluwakemi", "oh-loo-wah-keh-mee", "oluwaˈkemi"),
  entry("Omolara", "oh-moh-lah-rah", "omoˈlara"),
  entry("Omotola", "oh-moh-toh-lah", "omoˈtola"),
  entry("Opeyemi", "oh-peh-yeh-mee", "opeˈjemi"),
  entry("Oyinkansola", "oh-yin-kan-shoh-lah", "ojinkanˈʃola"),
  entry("Ronke", "ron-keh", "ˈrɔnke"),
  entry("Sade", "shah-deh", "ˈʃade"),
  entry("Segun", "sheh-goon", "ˈʃeɡun"),
  entry("Seun", "sheh-oon", "ˈʃeun"),
  entry("Sikiru", "see-kee-roo", "siˈkiru"),
  entry("Simisola", "see-mee-shoh-lah", "simiˈʃola"),
  entry("Taiwo", "tie-woh", "ˈtaiwo"),
  entry("Temitope", "teh-mee-toh-peh", "temiˈtope"),
  entry("Titilayo", "tee-tee-lah-yoh", "titiˈlajo"),
  entry("Tolu", "toh-loo", "ˈtolu"),
  entry("Tolulope", "toh-loo-loh-peh", "toluˈlope"),
  entry("Tosin", "toh-sin", "ˈtosin"),
  entry("Tunde", "toon-deh", "ˈtunde"),
  entry("Wale", "wah-leh", "ˈwale"),
  entry("Wole", "woh-leh", "ˈwole"),
  entry("Yemi", "yeh-mee", "ˈjemi"),
  entry("Yemisi", "yeh-mee-see", "jeˈmisi"),
  entry("Yinka", "yin-kah", "ˈjinka"),
  entry("Ogunleye", "oh-goon-leh-yeh", "oɡunˈleje"),
  entry("Ogunbiyi", "oh-goon-bee-yee", "oɡunˈbiji"),
  entry("Oyelaran", "oh-yeh-lah-ran", "ojeˈlaran"),
  entry("Fashola", "fah-shoh-lah", "faˈʃola"),
  entry("Ambode", "am-boh-deh", "amˈbode"),
  entry("Sanwo-Olu", "san-woh oh-loo", "ˈsanwo oˈlu"),
  entry("Osinbajo", "oh-sin-bah-joh", "osinˈbadʒo"),
  entry("Tinubu", "tee-noo-boo", "tiˈnubu"),
  entry("Awolowo", "ah-woh-loh-woh", "awoˈlowo"),
  entry("Obasanjo", "oh-bah-san-joh", "obaˈsandʒo"),
  entry("Soyinka", "shoh-yin-kah", "ʃoˈjinka"),
  entry("Balogun", "bah-loh-goon", "baˈloɡun"),
  entry("Bankole", "ban-koh-leh", "banˈkole"),
  entry("Fagbemi", "fag-beh-mee", "faɡˈbemi"),
  entry("Odunayo", "oh-doon-ah-yoh", "odunˈajo"),
  entry("Oyebode", "oh-yeh-boh-deh", "ojeˈbode"),
  entry("Oyekan", "oh-yeh-kan", "oˈjekan"),
  entry("Salako", "sah-lah-koh", "saˈlako"),
  entry("Shittu", "shee-too", "ˈʃitu"),
  entry("Adeboye", "ah-deh-boh-yeh", "adeˈboje"),
  entry("Bamidele", "bah-mee-deh-leh", "bamiˈdele"),
];

/** Igbo names, given and family. */
const IGBO_NAMES: readonly Pronunciation[] = [
  entry("Adaeze", "ah-dah-eh-zeh", "adaˈeze"),
  entry("Adaora", "ah-dah-oh-rah", "adaˈora"),
  entry("Amaka", "ah-mah-kah", "aˈmaka"),
  entry("Amara", "ah-mah-rah", "aˈmara"),
  entry("Anyanwu", "ah-nyan-woo", "aˈɲanwu"),
  entry("Chiamaka", "chee-ah-mah-kah", "tʃiaˈmaka"),
  entry("Chibueze", "chee-boo-eh-zeh", "tʃibuˈeze"),
  entry("Chidi", "chee-dee", "ˈtʃidi"),
  entry("Chidinma", "chee-din-mah", "tʃiˈdinma"),
  entry("Chika", "chee-kah", "ˈtʃika"),
  entry("Chinedu", "chee-neh-doo", "tʃiˈnedu"),
  entry("Chinonso", "chee-non-soh", "tʃiˈnɔnso"),
  entry("Chinwe", "chin-weh", "ˈtʃinwe"),
  entry("Chioma", "chee-oh-mah", "tʃiˈoma"),
  entry("Chukwudi", "choo-kwoo-dee", "tʃuˈkwudi"),
  entry("Chukwuemeka", "choo-kwoo-eh-meh-kah", "tʃukwuˈemeka"),
  entry("Ebuka", "eh-boo-kah", "eˈbuka"),
  entry("Ejike", "eh-jee-keh", "eˈdʒike"),
  entry("Emeka", "eh-meh-kah", "eˈmeka"),
  entry("Eze", "eh-zeh", "ˈeze"),
  entry("Ezinne", "eh-zin-neh", "eˈzine"),
  entry("Ifeanyi", "ee-feh-ah-nyee", "ifeˈaɲi"),
  entry("Ifeoma", "ee-feh-oh-mah", "ifeˈoma"),
  entry("Ikechukwu", "ee-keh-choo-kwoo", "ikeˈtʃukwu"),
  entry("Ikenna", "ee-ken-nah", "iˈkɛna"),
  entry("Kelechi", "keh-leh-chee", "keˈletʃi"),
  entry("Kenechukwu", "keh-neh-choo-kwoo", "keneˈtʃukwu"),
  entry("Ngozi", "n-goh-zee", "ˈŋɡozi"),
  entry("Nkechi", "n-keh-chee", "ˈnketʃi"),
  entry("Nkem", "n-kem", "ˈnkɛm"),
  entry("Nnamdi", "n-nam-dee", "ˈnnamdi"),
  entry("Nneka", "n-neh-kah", "ˈnneka"),
  entry("Nwachukwu", "n-wah-choo-kwoo", "nwaˈtʃukwu"),
  entry("Nwosu", "n-woh-soo", "ˈnwosu"),
  entry("Obi", "oh-bee", "ˈobi"),
  entry("Obinna", "oh-bin-nah", "oˈbina"),
  entry("Ogechi", "oh-geh-chee", "oˈɡetʃi"),
  entry("Okafor", "oh-kah-for", "oˈkafɔ"),
  entry("Okechukwu", "oh-keh-choo-kwoo", "okeˈtʃukwu"),
  entry("Okeke", "oh-keh-keh", "oˈkeke"),
  entry("Okonkwo", "oh-kon-kwoh", "oˈkɔŋkwo"),
  entry("Okoro", "oh-koh-roh", "oˈkoro"),
  entry("Onyeka", "on-yeh-kah", "oˈɲeka"),
  entry("Onyekachi", "on-yeh-kah-chee", "oɲeˈkatʃi"),
  entry("Somtochukwu", "som-toh-choo-kwoo", "somtoˈtʃukwu"),
  entry("Tochukwu", "toh-choo-kwoo", "toˈtʃukwu"),
  entry("Uche", "oo-cheh", "ˈutʃe"),
  entry("Uchenna", "oo-chen-nah", "uˈtʃɛna"),
  entry("Ugochukwu", "oo-goh-choo-kwoo", "uɡoˈtʃukwu"),
  entry("Uzoma", "oo-zoh-mah", "uˈzoma"),
  entry("Achebe", "ah-cheh-beh", "aˈtʃebe"),
  entry("Azikiwe", "ah-zee-kee-weh", "aziˈkiwe"),
  entry("Ojukwu", "oh-jook-woo", "oˈdʒukwu"),
  entry("Iwuchukwu", "ee-woo-choo-kwoo", "iwuˈtʃukwu"),
  entry("Nwankwo", "n-wan-kwoh", "ˈnwaŋkwo"),
  entry("Nnaji", "n-nah-jee", "ˈnnadʒi"),
  entry("Okorie", "oh-koh-ree-eh", "oˈkorie"),
  entry("Ogbonna", "og-bon-nah", "oɡˈbɔna"),
  entry("Chukwu", "choo-kwoo", "ˈtʃukwu"),
  entry("Mbah", "m-bah", "ˈmba"),
  entry("Odinaka", "oh-dee-nah-kah", "odiˈnaka"),
  entry("Munachi", "moo-nah-chee", "muˈnatʃi"),
  entry("Kamsi", "kam-see", "ˈkamsi"),
  entry("Kosisochukwu", "koh-see-soh-choo-kwoo", "kosisoˈtʃukwu"),
  entry("Chisom", "chee-som", "ˈtʃisɔm"),
  entry("Chiemeka", "chee-eh-meh-kah", "tʃieˈmeka"),
  entry("Chinaza", "chee-nah-zah", "tʃiˈnaza"),
];

/** Hausa, Fulani and Kanuri names, and the Arabic names as Northern Nigerians say them. */
const NORTHERN_NAMES: readonly Pronunciation[] = [
  entry("Abdullahi", "ab-dool-lah-hee", "abduˈlahi"),
  entry("Abdulrahman", "ab-dool-rah-man", "abdulˈrahman"),
  entry("Abubakar", "ah-boo-bah-kar", "abuˈbakar"),
  entry("Ahmed", "ah-med", "ˈahmɛd"),
  entry("Aisha", "ah-ee-shah", "aˈiʃa"),
  entry("Aliyu", "ah-lee-yoo", "aˈliju"),
  entry("Amina", "ah-mee-nah", "aˈmina"),
  entry("Aminu", "ah-mee-noo", "aˈminu"),
  entry("Atiku", "ah-tee-koo", "aˈtiku"),
  entry("Ayuba", "ah-yoo-bah", "aˈjuba"),
  entry("Bala", "bah-lah", "ˈbala"),
  entry("Bashir", "bah-sheer", "baˈʃir"),
  entry("Bello", "bel-loh", "ˈbɛlo"),
  entry("Buhari", "boo-hah-ree", "buˈhari"),
  entry("Dahiru", "dah-hee-roo", "daˈhiru"),
  entry("Danjuma", "dan-joo-mah", "danˈdʒuma"),
  entry("Dauda", "dow-dah", "ˈdauda"),
  entry("Fatima", "fah-tee-mah", "faˈtima"),
  entry("Garba", "gar-bah", "ˈɡarba"),
  entry("Hadiza", "hah-dee-zah", "haˈdiza"),
  entry("Halima", "hah-lee-mah", "haˈlima"),
  entry("Hassan", "has-san", "haˈsan"),
  entry("Hauwa", "how-wah", "ˈhauwa"),
  entry("Ibrahim", "ee-brah-heem", "ibraˈhim"),
  entry("Idris", "ee-drees", "iˈdris"),
  entry("Isah", "ee-sah", "ˈisa"),
  entry("Jamilu", "jah-mee-loo", "dʒaˈmilu"),
  entry("Jibril", "jee-breel", "dʒiˈbril"),
  entry("Kabir", "kah-beer", "kaˈbir"),
  entry("Kabiru", "kah-bee-roo", "kaˈbiru"),
  entry("Kaltum", "kal-toom", "kalˈtum"),
  entry("Lawal", "lah-wal", "laˈwal"),
  entry("Maryam", "mar-yam", "ˈmarjam"),
  entry("Mohammed", "moh-ham-med", "moˈhamɛd"),
  entry("Muhammad", "moo-ham-mad", "muˈhamad"),
  entry("Musa", "moo-sah", "ˈmusa"),
  entry("Nafisa", "nah-fee-sah", "naˈfisa"),
  entry("Nasir", "nah-seer", "naˈsir"),
  entry("Rabiu", "rah-bee-oo", "raˈbiu"),
  entry("Rukayya", "roo-kai-yah", "ruˈkaja"),
  entry("Sadiq", "sah-deek", "saˈdik"),
  entry("Salisu", "sah-lee-soo", "saˈlisu"),
  entry("Sani", "sah-nee", "ˈsani"),
  entry("Shehu", "sheh-hoo", "ˈʃehu"),
  entry("Suleiman", "soo-lay-man", "suleiˈman"),
  entry("Tanko", "tan-koh", "ˈtaŋko"),
  entry("Tijjani", "tee-jah-nee", "tiˈdʒani"),
  entry("Umar", "oo-mar", "ˈumar"),
  entry("Usman", "oos-man", "ˈusman"),
  entry("Yakubu", "yah-koo-boo", "jaˈkubu"),
  entry("Yusuf", "yoo-soof", "ˈjusuf"),
  entry("Zainab", "zai-nab", "ˈzainab"),
  entry("Zubairu", "zoo-bai-roo", "zuˈbairu"),
  entry("Adamu", "ah-dah-moo", "aˈdamu"),
  entry("Haruna", "hah-roo-nah", "haˈruna"),
  entry("Ismaila", "is-mah-ee-lah", "ismaˈila"),
  entry("Nuhu", "noo-hoo", "ˈnuhu"),
  entry("Bilkisu", "bil-kee-soo", "bilˈkisu"),
  entry("Sadiya", "sah-dee-yah", "saˈdija"),
  entry("Safiya", "sah-fee-yah", "saˈfija"),
  entry("Zahra", "zah-rah", "ˈzahra"),
  entry("Habiba", "hah-bee-bah", "haˈbiba"),
];

/** Edo, Urhobo, Itsekiri, Ijaw, Efik, Ibibio, Tiv and Idoma names. */
const SOUTHERN_AND_MIDDLE_BELT_NAMES: readonly Pronunciation[] = [
  entry("Osagie", "oh-sah-gee-eh", "oˈsaɡie"),
  entry("Osaze", "oh-sah-zeh", "oˈsaze"),
  entry("Osas", "oh-sas", "ˈosas"),
  entry("Eghosa", "eg-hoh-sah", "eˈɡosa"),
  entry("Ehis", "eh-hees", "ˈehis"),
  entry("Ivie", "ee-vee-eh", "iˈvie"),
  entry("Omoregie", "oh-moh-reh-gee-eh", "omoˈreɡie"),
  entry("Uwa", "oo-wah", "ˈuwa"),
  entry("Osahon", "oh-sah-hon", "oˈsahɔn"),
  entry("Efe", "eh-feh", "ˈefe"),
  entry("Onome", "oh-noh-meh", "oˈnome"),
  entry("Oghenekaro", "oh-geh-neh-kah-roh", "oɡeneˈkaro"),
  entry("Oghene", "oh-geh-neh", "oˈɡene"),
  entry("Ejiro", "eh-jee-roh", "eˈdʒiro"),
  entry("Tega", "teh-gah", "ˈteɡa"),
  entry("Ese", "eh-seh", "ˈese"),
  entry("Ovie", "oh-vee-eh", "oˈvie"),
  entry("Kome", "koh-meh", "ˈkome"),
  entry("Ufuoma", "oo-foo-oh-mah", "ufuˈoma"),
  entry("Ekpo", "ek-poh", "ˈekpo"),
  entry("Ekaette", "eh-kah-eh-teh", "ekaˈete"),
  entry("Emem", "eh-mem", "ˈemɛm"),
  entry("Ime", "ee-meh", "ˈime"),
  entry("Uduak", "oo-doo-ak", "ˈuduak"),
  entry("Nsikak", "n-see-kak", "ˈnsikak"),
  entry("Aniekan", "ah-nee-eh-kan", "aniˈekan"),
  entry("Okon", "oh-kon", "ˈɔkɔn"),
  entry("Etim", "eh-teem", "ˈetim"),
  entry("Effiong", "ef-fee-ong", "ˈɛfiɔŋ"),
  entry("Idara", "ee-dah-rah", "iˈdara"),
  entry("Utibe", "oo-tee-beh", "uˈtibe"),
  entry("Inyang", "in-yang", "ˈiɲaŋ"),
  entry("Bassey", "bah-see", "ˈbasi"),
  entry("Ochanya", "oh-chan-yah", "oˈtʃaɲa"),
  entry("Terkula", "ter-koo-lah", "terˈkula"),
  entry("Aondona", "ah-on-doh-nah", "aonˈdona"),
  entry("Ene", "eh-neh", "ˈene"),
  entry("Ochoche", "oh-choh-cheh", "oˈtʃotʃe"),
  entry("Tamuno", "tah-moo-noh", "taˈmuno"),
  entry("Tonye", "ton-yeh", "ˈtɔɲe"),
  entry("Ebiere", "eh-bee-eh-reh", "ebiˈere"),
  entry("Timipre", "tee-mee-preh", "tiˈmipre"),
  entry("Preye", "preh-yeh", "ˈpreje"),
];

/** Everyday words, food, dress and the household institutions a caller names. */
const EVERYDAY: readonly Pronunciation[] = [
  entry("naira", "nye-rah", "ˈnaira"),
  entry("kobo", "koh-boh", "ˈkobo"),
  entry("okada", "oh-kah-dah", "oˈkada"),
  entry("keke", "keh-keh", "ˈkeke"),
  entry("danfo", "dan-foh", "ˈdanfo"),
  entry("molue", "moh-loo-eh", "moˈlue"),
  entry("buka", "boo-kah", "ˈbuka"),
  entry("suya", "soo-yah", "ˈsuja"),
  entry("jollof", "joh-lof", "ˈdʒɔlɔf"),
  entry("garri", "gah-ree", "ˈɡari"),
  entry("egusi", "eh-goo-see", "eˈɡusi"),
  entry("agbada", "ag-bah-dah", "aɡˈbada"),
  entry("ankara", "an-kah-rah", "aŋˈkara"),
  entry("gele", "geh-leh", "ˈɡele"),
  entry("oga", "oh-gah", "ˈoɡa"),
  entry("abeg", "ah-beg", "aˈbɛɡ"),
  entry("wahala", "wah-hah-lah", "waˈhala"),
  entry("owambe", "oh-wam-beh", "oˈwambe"),
  entry("amala", "ah-mah-lah", "aˈmala"),
  entry("ewedu", "eh-weh-doo", "eˈwedu"),
  entry("fufu", "foo-foo", "ˈfufu"),
  entry("moi moi", "moy-moy", "ˈmoimoi"),
  entry("akara", "ah-kah-rah", "aˈkara"),
  entry("zobo", "zoh-boh", "ˈzobo"),
  entry("kilishi", "kee-lee-shee", "kiˈliʃi"),
  entry("tuwo", "too-woh", "ˈtuwo"),
  entry("ofada", "oh-fah-dah", "oˈfada"),
  entry("Ileya", "ee-leh-yah", "iˈleja"),
  entry("Sallah", "sal-lah", "ˈsala"),
  entry("NEPA", "neh-pah", "ˈnepa"),
  entry("LASTMA", "last-mah", "ˈlastma"),
  entry("PHCN", "P H C N"),
  entry("FRSC", "F R S C"),
  entry("NIN", "N I N"),
  entry("BVN", "B V N"),
  entry("NNPC", "N N P C"),
  entry("FIRS", "F I R S"),
  entry("NIMC", "N I M C"),
  entry("NYSC", "N Y S C"),
  entry("JAMB", "jamb", "dʒam"),
  entry("WAEC", "wah-ek", "ˈwaɛk"),
  entry("UNILAG", "yoo-nee-lag", "juniˈlaɡ"),
  entry("LASU", "lah-soo", "ˈlasu"),
  entry("UNIBEN", "yoo-nee-ben", "juniˈbɛn"),
  entry("FUTA", "foo-tah", "ˈfuta"),
  entry("LUTH", "looth", "luθ"),
  entry("UCH", "U C H"),
  entry("OAU", "O A U"),
  entry("UNN", "U N N"),
  entry("MTN", "M T N"),
  entry("Glo", "gloh", "ɡlo"),
  entry("9mobile", "nine mobile", "ˈnain ˈmobail"),
  entry("Dangote", "dan-goh-teh", "danˈɡote"),
  entry("Jumia", "joo-mee-ah", "ˈdʒumia"),
  entry("Konga", "kon-gah", "ˈkɔŋɡa"),
  entry("Gokada", "goh-kah-dah", "ɡoˈkada"),
  entry("GTBank", "G T bank", "ˌdʒiːˈtiː baŋk"),
  entry("GTB", "G T B"),
  entry("UBA", "U B A"),
  entry("FCMB", "F C M B"),
  entry("Ecobank", "eh-koh-bank", "ˈekobaŋk"),
  entry("Wema", "weh-mah", "ˈwema"),
  entry("Kuda", "koo-dah", "ˈkuda"),
  entry("Opay", "oh-pay", "ˈopei"),
  entry("Moniepoint", "moh-nee-point", "ˈmonipɔint"),
  entry("Paga", "pah-gah", "ˈpaɡa"),
  entry("Remita", "reh-mee-tah", "reˈmita"),
  entry("Stanbic", "stan-bik", "ˈstanbik"),
  entry("Jaiz", "jah-eez", "dʒaˈiz"),
  entry("Providus", "proh-vee-dus", "ˈprovidus"),
  entry("Leadway", "leed-way", "ˈlidwei"),
  entry("AIICO", "ah-ee-koh", "aˈiko"),
  entry("NAICOM", "nye-kom", "ˈnaikɔm"),
  entry("NHIS", "N H I S"),
  entry("NSITF", "N S I T F"),
  entry("PenCom", "pen-kom", "ˈpɛnkɔm"),
  entry("Axa Mansard", "ak-sah man-sard", "ˈaksa manˈsard"),
  entry("Mansard", "man-sard", "manˈsard"),
];

/** Every built-in entry, one table. An organisation's own list is merged over it. */
export const NIGERIAN_LEXICON: readonly Pronunciation[] = [
  ...STATES_AND_CAPITALS,
  ...LAGOS,
  ...TOWNS,
  ...YORUBA_NAMES,
  ...IGBO_NAMES,
  ...NORTHERN_NAMES,
  ...SOUTHERN_AND_MIDDLE_BELT_NAMES,
  ...EVERYDAY,
];

const TERM_LIMIT = 80;
const SAY_AS_LIMIT = 120;
const IPA_LIMIT = 120;
const LIST_LIMIT = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stored list, read back safely. The column is jsonb and holds whatever was written; a row
 * that is not shaped like an entry is dropped rather than allowed to reach the voice, and
 * the list is capped so a runaway write cannot make every turn expensive.
 */
export const parsePronunciations = (raw: unknown): readonly Pronunciation[] => {
  if (!Array.isArray(raw)) return [];
  const out: Pronunciation[] = [];
  for (const item of raw.slice(0, LIST_LIMIT)) {
    if (!isRecord(item)) continue;
    const term = typeof item["term"] === "string" ? item["term"].trim() : "";
    const sayAs = typeof item["sayAs"] === "string" ? item["sayAs"].trim() : "";
    const ipa = typeof item["ipa"] === "string" ? item["ipa"].trim() : "";
    if (term === "" || term.length > TERM_LIMIT || sayAs === "" || sayAs.length > SAY_AS_LIMIT) continue;
    if (ipa.length > IPA_LIMIT) continue;
    out.push(ipa === "" ? { term, sayAs } : { term, sayAs, ipa });
  }
  return out;
};

/**
 * The built-in list with an organisation's own entries over it. Theirs win on the same
 * term, compared without case, because they know how their own customers say it.
 */
export const mergePronunciations = (
  base: readonly Pronunciation[],
  overrides: readonly Pronunciation[],
): readonly Pronunciation[] => {
  const byTerm = new Map<string, Pronunciation>();
  for (const item of base) byTerm.set(item.term.toLowerCase(), item);
  for (const item of overrides) byTerm.set(item.term.toLowerCase(), item);
  return [...byTerm.values()];
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word boundary that respects letters beyond ASCII and does not split on a hyphen inside a term. */
const boundary = (pattern: string): string => `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`;

/**
 * A matcher over every term, longest first, so "Ibeju Lekki" is taken whole before "Lekki"
 * can claim half of it. Built once per list rather than per sentence: a call says forty
 * sentences and the list does not change between them.
 */
export const compilePronunciations = (
  entries: readonly Pronunciation[],
): ((text: string, mode: PronunciationMode) => string) => {
  if (entries.length === 0) return (text) => text;
  const byKey = new Map<string, Pronunciation>();
  for (const item of entries) byKey.set(item.term.toLowerCase(), item);
  const alternation = [...byKey.keys()]
    .sort((a, b) => b.length - a.length)
    .map((term) => escapeRegExp(term).replace(/\s+/g, "\\s+"))
    .join("|");
  const matcher = new RegExp(boundary(alternation), "giu");
  const phoneme = (item: Pronunciation, original: string): string =>
    item.ipa === undefined ? item.sayAs : `<phoneme alphabet="ipa" ph="${item.ipa}">${original}</phoneme>`;

  return (text, mode) => {
    /* Never inside a tag another pass already wrote. Only the phoneme tag exists today, and
       the guard is cheap: a term that appears inside one is left alone. */
    const untouched = text.split(/(<phoneme\b[^>]*>[^<]*<\/phoneme>)/);
    return untouched
      .map((piece, index) =>
        index % 2 === 1
          ? piece
          : piece.replace(matcher, (found: string) => {
              const item = byKey.get(found.toLowerCase().replace(/\s+/g, " "));
              if (item === undefined) return found;
              return mode === "phoneme-tags" ? phoneme(item, found) : item.sayAs;
            }),
      )
      .join("");
  };
};

/** Say every listed term the way its entry says, in the form the voice can take. */
export const applyPronunciations = (
  text: string,
  entries: readonly Pronunciation[],
  mode: PronunciationMode = "respelling",
): string => compilePronunciations(entries)(text, mode);
