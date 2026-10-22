"""Classify tested facts using question and answer text only; never use help text."""
import re

RULES = [
 ('routine.drugs',r'\b(?:drug|droga|cannabis|cocaine|cocaína|ecstasy|éxtasis|amphetamine|anfetamina|lsd\b|narcotic)',9),
 ('routine.alcohol',r'alcohol|alcoholemia|breathal',9),
 ('numbers.alcohol',r'(?:alcohol|alcoholemia|breathal).*(?:limit|tasa|máxim|mg|g/l)|(?:mg/l|g/l|milligrams per litre|grams per litre)',11),
 ('routine.fatigue',r'microsleep|microsueño|somnol|\bdrows|\bsleep|\bsueño|\btired|\bfatigue|\bfatiga|cansancio',10),
 ('routine.distraction',r'\bdistraction|distracci|mobile phone|teléfono móvil|\bgps\b|navigator|navegador|\bsmok|\bfumar',9),
 ('routine.reaction',r'reaction time|tiempo de reacción',8),
 ('routine.emotions',r'aggress|agresiv|\bstress|estrés|emotional|emocional|\bpanic|pánico',9),
 ('routine.health',r'medication|medicamento|medicine|illness|disease|enfermedad|allerg|alerg|resfriado|\bcold\b|antihist|tranquil|sedative|sedante|depress|depres|medical condition',10),
 ('routine.seatbelts',r'seat.?belt|cintur[oó]n',10),
 ('routine.helmets',r'\bhelmet|\bcasco',11),
 ('routine.safety',r'defensive driv|preventive driv|conducción preventiva|conducción defensiva|risk.perception|percepción del riesgo|elderly|personas mayores|young driver|jóvenes|risk.group|grupo.de.riesgo|accident.*(?:cause|factor)|(?:cause|factor).*accident|traffic.*(?:cost|coste)|cost.*(?:traffic|accident)',4),
 ('routine.ecodriving',r'fuel|combustible|efficient driv|conducción eficiente|consum(?:ption|o)|save.*(?:petrol|diesel|gasolina)|ahorr',9),
 ('eco.environment',r'pollut|contamin|emission|emision|carbon dioxide|co2|recycl|recicl',9),
 ('eco.noise',r'noise|ruido|silencer|silenciador|exhaust pipe|tubo de escape',10),
 ('numbers.speeds',r'(?:speed|velocidad).*(?:maximum|minimum|limit|máxim|mínim|límite)|(?:maximum|minimum|limit|máxim|mínim|límite).*(?:speed|velocidad)|(?:\d+\s*(?:km/h|kilometres per hour)).*(?:not exceed|no.*superar)|(?:speed permitted|velocidad permitida)',10),
 ('speed.adaptation',r'appropriate speed|suitable speed|speed.*(?:adapt|suitable|circumstance|appropriate)|velocidad.*(?:adecua|adapta)|excessive speed|velocidad excesiva|abnormally.*(?:low|slow)|anormalmente reducida|tunnel effect|efecto túnel',9),
 ('numbers.distances',r'safety distance|distancia de seguridad|separación.*(?:vehículo|peat|cicli)|(?:distance|separation).*(?:leave|keep|maintain)|(?:leave|keep|maintain).*(?:distance|separation)|intervalo lateral|lateral.*(?:distance|separation)|distancia.*(?:frontal|lateral)',10),
 ('speed.stopping',r'stopping distance|braking distance|reaction distance|distancia de (?:detención|frenado|reacción)',12),
 ('numbers.dimensions',r'(?:load|cargo|carga).*(?:protrud|overhang|width|height|length|anch|larg|sobresal|altura)|(?:protrud|overhang|sobresal).*(?:load|cargo|carga)|maximum.*(?:width|height|length)|anchura máxima|altura máxima',10),
 ('numbers.capacity',r'number of (?:seats|passengers)|número de (?:plazas|pasajeros)|(?:how many|cuánt[ao]s?).*(?:people|persons|passengers|personas|pasajeros|plazas)',10),
 ('numbers.displacement',r'cylinder|cilindr|cm3|cm³|\bcc\b',9),
 ('numbers.technical',r'tread.*(?:depth|mm)|profundidad.*(?:dibujo|ranura)|\b1[.,]6\s*mm',8),
 ('numbers.dates',r'(?:sign|señal).*(?:date|calendar|day|hour|fecha|hora|día)|(?:odd|even).*(?:day|month)|(?:par|impar).*(?:día|mes)',9),
 ('numbers.deadlines.novice',r'novice|new qualified driver|newly qualified|conductor novel|first.*licence|primer permiso|placa.*\bl\b',10),
 ('numbers.deadlines.itv',r'(?:inspection|\bitv\b|\bmot\b).*(?:years|months|año|mes|cuándo|when|often)|(?:years|months|año|mes).*(?:inspection|\bitv\b|\bmot\b)',11),
 ('numbers.deadlines.licences',r'(?:licen[cs]e|permiso|conducción).*(?:valid|renov|renew|expir|caduc|vigencia)|(?:renov|renew).*(?:licen[cs]e|permiso)',10),
 ('numbers.deadlines.certificates',r'certificate|certificado',5),
 ('numbers.deadlines.transfer_buyer',r'buyer|purchaser|comprador|buy.*vehicle|compra.*vehículo',10),
 ('numbers.deadlines.transfer_seller',r'sell.*(?:car|vehicle)|vender.*(?:coche|vehículo)|vende.*vehículo|seller|vendedor|notify.*sale|notificar.*venta',10),
 ('signs.speed',r'(?:sign|señal|marking|marca).*(?:speed|velocidad)|(?:speed|velocidad).*(?:sign|señal)',12),
 ('signs.priority',r'give.way sign|stop sign|priority sign|señal.*(?:ceda|stop|prioridad)|(?:sign|señal).*(?:give way|yield|ceder el paso)',12),
 ('signs.mandatory',r'(?:sign|señal).*(?:compulsory|mandatory|obliga|only direction|únic.*direcc)|(?:must follow|debe seguir).*(?:direction|direcci)',9),
 ('signs.warning',r'(?:sign|señal).*(?:warn|danger|peligro|adviert)|(?:danger|peligro).*(?:sign|señal)',9),
 ('signs.restrictions',r'(?:sign|señal).*(?:prohibit|forbid|no entry|prohíb|prohib|restric)|(?:entry prohibited|entrada prohibida)',9),
 ('signs.parking',r'(?:sign|señal).*(?:park|estacion|stop.*park)|(?:park|estacion).*(?:sign|señal)',11),
 ('signs.lanes',r'(?:sign|señal).*(?:lane|carril)|(?:lane|carril).*(?:sign|señal)',9),
 ('signs.temporary',r'road.?works|work.zone|obras|temporary sign|señalización temporal',10),
 ('signs.vehicle_plates',r'v-\d|vehicle.*plate|placa|distintivo|badge|orange panel|panel naranja',9),
 ('signs.markings',r'road marking|marca(?:s)? vial|horizontal sign|señal horizontal|(?:white|yellow|continuous|broken|solid|blanca|amarilla|continua|discontinua).*l[ií]ne|(?:line|línea).*(?:white|yellow|continuous|broken|solid|blanca|amarilla|continua|discontinua)|hatched|cebreado|stop.line|línea de detención|arrow.*(?:road|painted)|flecha.*(?:calzada|pintad)',11),
 ('signs.information',r'(?:sign|señal).*(?:indicat|inform|advis|recomend)|(?:this sign|esta señal|señal de la|the sign)',3),
 ('priority.officer',r'(?:(?:traffic|police) (?:officer|agent)|agente|regulador).*(?:signal|señal|arm|brazo|stop|deten|instruct|orden)|señal.*agente',12),
 ('priority.lights',r'traffic light|semáforo|red light|luz roja|green light|luz verde|flashing amber|amarilla intermitente',11),
 ('priority.tram',r'tram|tranvía',9),
 ('priority.sign',r'(?:give way|yield|ceder el paso|prioridad).*(?:sign|señal)|(?:sign|señal).*(?:priority|prioridad|give way|ceder)|\bstop\b.*(?:junction|intersection|cruce|intersección)',8),
 ('priority.cyclists',r'(?:cyclist|ciclista).*(?:priority|prioridad|give way|ceder)|(?:priority|prioridad|give way|ceder).*(?:cyclist|ciclista)',11),
 ('priority.merging',r'(?:join|merg|incorpor).*(?:give way|yield|priority|ceder|prioridad)|(?:give way|yield|ceder).*(?:join|merg|incorpor)',11),
 ('priority.general',r'right of way|priority|prioridad|give way|yield|ceder el paso|uncontrolled intersection|intersección sin señal',7),
 ('priority.narrow',r'narrow|estrech|steep gradient|steep slope|gran pendiente|fuerte pendiente',10),
 ('priority.emergency',r'emergency vehicle|priority vehicle|vehículo prioritario|servicio.*urgenc|ambulance|ambulancia|police vehicle|vehículo policial|vehículo de.*policía',11),
 ('driving.roundabouts',r'roundabout|glorieta|rotonda',12),
 ('driving.roads',r'type of road|clase de vía|(?:what|which).*(?:road.*(?:is this|shown)|road are you)|(?:qué|cuál).*tipo.*vía|autopista|autovía|motorway|dual carriageway',2),
 ('driving.lanes',r'lane|carril|hard shoulder|arcén|central reservation|mediana|one.way|sentido único',5),
 ('driving.merging',r'joining.*(?:traffic|road)|merge.*(?:traffic|road)|incorpora|acceleration lane|carril de aceleración',9),
 ('driving.turns',r'turn (?:left|right)|girar.*(?:izquierda|derecha)|giro.*(?:izquierda|derecha)|change of direction|cambio de dirección',8),
 ('driving.uturns',r'u.turn|cambio de sentido|cambiar.*sentido',11),
 ('driving.overtaking',r'overtak|adelant|opering',10),
 ('driving.parking',r'\bpark|estacion|\bstop(?:ping)?\b(?!.*(?:line|sign|traffic light))|\bparar|\bparada',7),
 ('driving.pedestrians',r'pedestrian|peat[oó]n',6),
 ('driving.weather',r'\brain\b|\blluvia|aquaplan|wet.*(?:road|surface)|calzada mojada',10),
 ('conditions.ice',r'\bice\b|hielo|\bsnow\b|nieve|snow.chain|cadenas.*nieve',11),
 ('conditions.wind',r'\bwind\b|viento',11),
 ('conditions.fog',r'\bfog\b|niebla',10),
 ('conditions.dark',r'\bnight\b|\bnoche\b|glare|dazzl|deslumbr|sunset|sunrise|poor.*visib|visibilidad.*reduc',6),
 ('driving.braking',r'\bbrak|\bfren|engine.brak|freno.motor|downhill|descenso|\bgear|\bmarcha',5),
 ('driving.signals',r'\bhorn|claxon|honk|acoustic signal|señal.*acústic|indicator|intermitente|arm.*signal|signal.*arm|brazo.*señal',10),
 ('driving.reversing',r'\brevers|marcha atrás',12),
 ('driving.crossings',r'level crossing|paso a nivel|railway crossing|mobile bridge|puente móvil',12),
 ('driving.tunnels',r'tunnel|túnel|underpass|paso inferior',10),
 ('vehicle.lights',r'headlight|headlamp|dipped.beam|low.beam|main.beam|full.beam|position light|sidelight|parking light|fog light|alumbrado|luces|luz de|luz.*(?:cruce|carretera|posición|antiniebla)|rotating.*light|luz rotativa',11),
 ('vehicle.visibility',r'\bmirror|espejo|rear.view|retrovisor|blind.spot|ángulo muerto|windscreen|parabrisas|windshield',10),
 ('vehicle.passive',r'airbag|air.bag|head.restraint|reposacabezas|passive safety|seguridad pasiva|crumple|chassis|chasis|bodywork|carrocería',10),
 ('vehicle.children',r'child.*(?:seat|restraint)|(?:seat|restraint).*child|sistema de retención infantil|dispositivo de retención|asiento.*(?:menor|niño)',12),
 ('vehicle.tyres',r'\btyre|\btire\b|neumático|tread|dibujo.*(?:rueda|neumático)',11),
 ('vehicle.passengers',r'passenger|pasajero|ocupante|transport.*(?:people|personas)|seat.*(?:front|rear)|asiento.*(?:delantero|trasero)',5),
 ('vehicle.cargo',r'\bload\b|\bcargo\b|\bcarga\b|loading|descarga',9),
 ('vehicle.dangerous_goods',r'dangerous goods|mercancías peligrosas',12),
 ('vehicle.motorcycles',r'\bmotorcycle|\bmotorbike|\bmoped|motocicleta|ciclomotor|\bmoto\b',4),
 ('transport.cycles',r'\bcyclist|\bbicycle|\bbike\b|ciclista|bicicleta|pedal.assist|pedaleo asistido',6),
 ('transport.trailers',r'\btrailer|remolque|caravan|caravana',6),
 ('vehicle.classification',r'quadricycle|cuadriciclo|considered.*(?:vehicle|motor)|considera.*vehículo|defined as|se define|definition|definición|classified|clasifica',9),
 ('vehicle.adas',r'\badas\b|\babs\b|\besp\b|\bedr\b|\blka\b|\bf cw\b|\bfcw\b|\bddr\b|driver assistance|assistance system|sistema.*(?:asistencia|ayuda)|cruise control|control de crucero|lane.keep|mantenimiento de carril',12),
 ('vehicle.mechanics',r'engine oil|aceite|lubrica|coolant|refriger|battery|batería|maintenance|mantenimiento|suspension|suspensión|steering|dirección.*(?:sistema|vehículo)|brake.*(?:disc|pad|fluid)|(?:disco|pastilla|líquido).*freno|clutch|embrague',10),
 ('documents.permissions',r'(?:licen[cs]e|permiso|categoría).*(?:drive|conduc|authori|autoriza|category|categoría)|(?:licen[cs]e|permiso).*[ab][12]?\b',10),
 ('documents.itv',r'\bitv\b|\bmot\b|technical inspection|inspección técnica',9),
 ('documents.registration',r'registration|matricula|matrícula|vehicle.*document|document.*vehículo|change of address|cambio.*domicilio|fotocopia|photocopy',8),
 ('documents.points',r'\bpoints\b|\bpuntos\b|licen[cs]e.*(?:lost|withdraw|suspend|revok)|permiso.*(?:pérdida|retirada|suspens)',11),
 ('documents.insurance',r'insurance|\bseguro obligatorio|asegur|seguro.*responsabilidad',12),
 ('incidents.scene',r'accident.*scene|lugar.*accidente|warning triangle|triángulo|\bv.?16\b|hazard.warning device|dispositivo.*preseñalización|protect.*(?:scene|accident)|proteger.*accidente|\bpah\b|\bpas\b',10),
 ('incidents.emergency_call',r'\b112\b|ecall|emergency.*(?:call|number)|teléfono.*emergencia|llamada.*(?:auxilio|emergencia)',13),
 ('incidents.first_aid',r'first aid|primeros auxilios|injured|herido|victim|víctima|bleed|hemorrag|resuscitat|reanim|unconscious|inconsciente|life.saving|soporte vital|burn|quemadura',11),
 ('incidents.towing',r'\btow|remolcar|breakdown|avería|vehicle.*(?:immobil|stopped.*due)|vehículo.*inmovilizado',9),
 ('incidents.fire',r'vehicle.*fire|fire.*vehicle|incendio|extintor|extinguish',12),
]

def classify_text(question, answers):
    """Only supplied prompt/answer fields enter classification."""
    correct = ' '.join(a['text'] for a in answers if a.get('correct'))
    prompt = question.lower()
    text = prompt + ' ' + correct.lower()
    scored = {tag: score for tag, pattern, score in RULES if re.search(pattern, text, re.I | re.S)}
    # Generic contextual mentions cannot turn an operational question into a speed-limit question.
    if 'numbers.speeds' in scored and not re.search(r'(?:maximum|minimum|limit|máxim|mínim|límite|permitted|permitida).*(?:speed|velocidad)|(?:speed|velocidad).*(?:maximum|minimum|limit|máxim|mínim|límite|permitted|permitida)|(?:qué|what|cuál).*velocidad|what.*speed', prompt, re.S):
        scored.pop('numbers.speeds')
    if 'numbers.speeds' in scored and re.search(r'how many.*mirror|cuántos.*espejos',prompt,re.S): scored.pop('numbers.speeds')
    if 'signs.information' in scored and any(k.startswith('signs.') and k != 'signs.information' for k in scored): scored.pop('signs.information')
    if 'priority.general' in scored and any(k.startswith('priority.') and k != 'priority.general' for k in scored): scored.pop('priority.general')
    if 'driving.parking' in scored and re.search(r'(?:stop|detener|detenga).*(?:traffic light|semáforo|officer|agente|stop sign|señal)', text, re.S): scored.pop('driving.parking')
    if 'driving.braking' in scored and not re.search(r'brak|fren|gear|marcha.*(?:larga|corta)|engine.*(?:hill|slope)|motor.*(?:pendiente|descenso)', text): scored.pop('driving.braking')
    # Specific vehicle references in a generic lighting, drug or licensing explanation are not vehicle topics.
    if 'routine.health' in scored and 'routine.drugs' in scored and not re.search(r'illegal|narcotic|cannabis|cocaine|cocaína|ecstasy|éxtasis|\blsd\b|anfetamina', text): scored.pop('routine.drugs')
    if not scored: return [], None
    primary = max(scored, key=lambda tag: scored[tag])
    tags = [tag for tag, score in scored.items() if score >= max(7, scored[primary]-3)]
    # Keep the first low-confidence candidate for editorial review rather than silently dropping the question.
    if not tags: tags=[primary]
    return sorted(tags), primary
