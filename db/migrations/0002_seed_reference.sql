-- Reference data only. No incidents are ever seeded.
INSERT INTO incident_categories (code, label, sort_order) VALUES
 ('murder','Murder and attempted murder',1),
 ('assault','Assault and other violent offences',2),
 ('robbery_burglary','Robbery and burglary',3),
 ('theft','Theft and vehicle theft',4),
 ('women_children','Crimes against women and children',5),
 ('cyber_fraud','Cybercrime and financial fraud',6),
 ('drugs','Drug-related offences',7),
 ('other','Other reported offences',8),
 ('unknown','Unknown or insufficient information',9);
-- Map-default centre only (city centre), not an incident location.
INSERT INTO cities (slug, name, state, centroid)
VALUES ('nagpur','Nagpur','Maharashtra', ST_SetSRID(ST_MakePoint(79.0882, 21.1458),4326)::geography);
