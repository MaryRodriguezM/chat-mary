FROM nginx:alpine

# Solo los archivos de la página
COPY index.html styles.css app.js config.js /usr/share/nginx/html/

EXPOSE 80